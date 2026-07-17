use std::io::Cursor;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::providers::deserialize_provider_order;

pub const MAX_PHOTO_BODY: usize = 18 * 1024 * 1024;
const MAX_DECODED_BYTES: usize = 12 * 1024 * 1024;
const MAX_DECODE_ALLOCATION: u64 = 64 * 1024 * 1024;
const MAX_PIXELS: u64 = 16_000_000;
const MAX_DIMENSION: u32 = 8_000;
const MIN_DIMENSION: u32 = 64;

#[derive(Debug, Deserialize)]
pub struct PhotoUploadRequest {
    #[serde(alias = "data_base64", alias = "data_url")]
    pub image: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_provider_order")]
    pub provider_order: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct PhotoAnalyzeRequest {
    #[serde(default)]
    pub photo_id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub context: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_provider_order")]
    pub provider_order: Vec<String>,
}

pub struct ProcessedPhoto {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone)]
pub struct PhotoStore {
    directory: PathBuf,
}

impl PhotoStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    pub async fn save(&self, jpeg: &[u8]) -> Result<String, String> {
        tokio::fs::create_dir_all(&self.directory)
            .await
            .map_err(|_| "Photo storage is unavailable".to_string())?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut hasher = Sha256::new();
        hasher.update(jpeg);
        hasher.update(nonce.to_le_bytes());
        let id = format!("{:x}", hasher.finalize());
        let destination = self.path_for_id(&id)?;
        let temporary = self.directory.join(format!(".{id}.tmp"));
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|_| "Photo storage is unavailable".to_string())?;
        if file.write_all(jpeg).await.is_err() || file.sync_all().await.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err("Photo storage is unavailable".to_string());
        }
        drop(file);
        if tokio::fs::rename(&temporary, destination).await.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err("Photo storage is unavailable".to_string());
        }
        Ok(id)
    }

    pub async fn load(&self, id: &str) -> Result<Vec<u8>, String> {
        let path = self.path_for_id(id)?;
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|_| "Photo not found".to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_DECODED_BYTES as u64 {
            return Err("Photo not found".to_string());
        }
        tokio::fs::read(path)
            .await
            .map_err(|_| "Photo not found".to_string())
    }

    pub fn id_from_reference(photo_id: Option<&str>, url: Option<&str>) -> Option<String> {
        let candidate = photo_id.or_else(|| {
            url.and_then(|url| {
                url.strip_prefix("/api/osm-ai/photos/")
                    .and_then(|path| path.strip_suffix(".jpg"))
            })
        })?;
        valid_id(candidate).then(|| candidate.to_string())
    }

    fn path_for_id(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("Invalid photo identifier".to_string());
        }
        Ok(self.directory.join(format!("{id}.jpg")))
    }
}

pub fn decode_and_reencode(request: &PhotoUploadRequest) -> Result<ProcessedPhoto, String> {
    let (data_mime, encoded) = split_data_url(&request.image)?;
    let estimated_size = encoded.len().saturating_mul(3) / 4;
    if estimated_size == 0 || estimated_size > MAX_DECODED_BYTES {
        return Err("Photo file is empty or too large".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| "Photo is not valid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_DECODED_BYTES {
        return Err("Photo file is empty or too large".to_string());
    }
    let format = image::guess_format(&bytes).map_err(|_| "Unsupported photo format".to_string())?;
    let actual_mime = match format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::WebP => "image/webp",
        _ => return Err("Only JPEG, PNG, and WebP photos are accepted".to_string()),
    };
    for declared in [data_mime, request.mime_type.as_deref()]
        .into_iter()
        .flatten()
    {
        if !declared.trim().eq_ignore_ascii_case(actual_mime) {
            return Err("Photo MIME type does not match its contents".to_string());
        }
    }

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOCATION);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "Photo dimensions could not be read".to_string())?;
    let (width, height) = decoder.dimensions();
    if !dimensions_allowed(width, height) || decoder.total_bytes() > MAX_DECODE_ALLOCATION {
        return Err("Photo dimensions are outside the allowed range".to_string());
    }
    let orientation = decoder
        .orientation()
        .map_err(|_| "Photo orientation could not be read".to_string())?;
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|_| "Photo could not be decoded".to_string())?;
    image.apply_orientation(orientation);
    let (width, height) = image.dimensions();
    if !dimensions_allowed(width, height) {
        return Err("Photo dimensions are outside the allowed range".to_string());
    }

    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 88)
        .encode_image(&image)
        .map_err(|_| "Photo could not be re-encoded".to_string())?;
    if jpeg.len() > MAX_DECODED_BYTES {
        return Err("Re-encoded photo is too large".to_string());
    }
    Ok(ProcessedPhoto {
        jpeg,
        width,
        height,
    })
}

fn dimensions_allowed(width: u32, height: u32) -> bool {
    width >= MIN_DIMENSION
        && height >= MIN_DIMENSION
        && width <= MAX_DIMENSION
        && height <= MAX_DIMENSION
        && u64::from(width) * u64::from(height) <= MAX_PIXELS
}

fn split_data_url(value: &str) -> Result<(Option<&str>, &str), String> {
    let value = value.trim();
    if !value.starts_with("data:") {
        return Ok((None, value));
    }
    let (metadata, encoded) = value
        .split_once(',')
        .ok_or_else(|| "Invalid photo data URL".to_string())?;
    let metadata = metadata
        .strip_prefix("data:")
        .ok_or_else(|| "Invalid photo data URL".to_string())?;
    let (mime, encoding) = metadata
        .split_once(';')
        .ok_or_else(|| "Invalid photo data URL".to_string())?;
    if encoding != "base64" {
        return Err("Photo data URL must use base64".to_string());
    }
    Ok((Some(mime), encoded))
}

fn valid_id(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_data_url() -> String {
        let image = image::RgbImage::from_pixel(64, 64, image::Rgb([20, 80, 140]));
        let mut bytes = Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, ImageFormat::Png)
            .expect("encode PNG");
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
        )
    }

    fn oriented_jpeg_data_url() -> String {
        let image = image::RgbImage::from_pixel(64, 96, image::Rgb([20, 80, 140]));
        let mut jpeg = Vec::new();
        JpegEncoder::new(&mut jpeg)
            .encode_image(&image)
            .expect("encode JPEG");

        // Big-endian TIFF with one SHORT Orientation=6 entry (rotate 90 degrees).
        let exif = [
            b'E', b'x', b'i', b'f', 0, 0, b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 1, 18, 0, 3, 0, 0,
            0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
        ];
        let segment_length = u16::try_from(exif.len() + 2).expect("small EXIF segment");
        let mut oriented = Vec::with_capacity(jpeg.len() + exif.len() + 4);
        oriented.extend_from_slice(&jpeg[..2]);
        oriented.extend_from_slice(&[0xff, 0xe1]);
        oriented.extend_from_slice(&segment_length.to_be_bytes());
        oriented.extend_from_slice(&exif);
        oriented.extend_from_slice(&jpeg[2..]);
        format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(oriented)
        )
    }

    #[test]
    fn upload_reencodes_to_jpeg_and_strips_container_metadata() {
        let request = PhotoUploadRequest {
            image: png_data_url(),
            mime_type: Some("image/png".to_string()),
            provider_order: vec![],
        };
        let processed = decode_and_reencode(&request).expect("valid photo");
        assert_eq!(processed.width, 64);
        assert_eq!(
            image::guess_format(&processed.jpeg).expect("detect JPEG"),
            ImageFormat::Jpeg
        );
    }

    #[test]
    fn rejects_mime_mismatch() {
        let request = PhotoUploadRequest {
            image: png_data_url(),
            mime_type: Some("image/jpeg".to_string()),
            provider_order: vec![],
        };
        assert!(decode_and_reencode(&request).is_err());
    }

    #[test]
    fn applies_exif_orientation_before_stripping_metadata() {
        let request = PhotoUploadRequest {
            image: oriented_jpeg_data_url(),
            mime_type: Some("image/jpeg".to_string()),
            provider_order: vec![],
        };
        let processed = decode_and_reencode(&request).expect("valid oriented photo");
        assert_eq!((processed.width, processed.height), (96, 64));
        let decoded = image::load_from_memory(&processed.jpeg).expect("re-encoded JPEG");
        assert_eq!(decoded.dimensions(), (96, 64));
    }

    #[test]
    fn only_accepts_own_public_photo_urls() {
        let id = "a".repeat(64);
        assert_eq!(
            PhotoStore::id_from_reference(None, Some(&format!("/api/osm-ai/photos/{id}.jpg"))),
            Some(id)
        );
        assert!(PhotoStore::id_from_reference(None, Some("https://example.com/x.jpg")).is_none());
    }
}
