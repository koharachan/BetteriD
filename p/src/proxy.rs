use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::BytesMut;
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use hyper::body::HttpBody;
use hyper::server::conn::AddrStream;
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body as HyperBody, Server};
use log::{debug, error, info};
use reqwest::Client as ReqwestClient;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{Mutex, Semaphore};
use url::{Url, form_urlencoded};

use crate::ai::AiRouter;
use crate::cache::{CacheEntry, CacheHandle};
use crate::config::ProxyConfig;
use crate::kimi::{TagSuggestionError, TagSuggestionRequest};
use crate::photos::{
    MAX_PHOTO_BODY, PhotoAnalyzeRequest, PhotoStore, PhotoUploadRequest, decode_and_reencode,
};
use crate::privacy::{PrivacyError, PrivacyUploader};
use crate::providers::deserialize_provider_order;
use crate::translate::{FreeTranslator, Translator};

const AI_BODY_LIMIT: usize = 64 * 1024;
const PRIVACY_BODY_LIMIT: usize = 8 * 1024 * 1024;
const AI_RATE_LIMIT: usize = 30;
const AI_RATE_WINDOW: Duration = Duration::from_secs(60);
const AI_RATE_BUCKET_LIMIT: usize = 10_000;
const AI_MAX_CONCURRENT_REQUESTS: usize = 16;
const AI_MAX_CONCURRENT_VISUAL_REQUESTS: usize = 2;
const PHOTO_CONTEXT_MAX_BYTES: usize = 4 * 1024;
const TILE_FALLBACK_CACHE_CONTROL: &str = "public, max-age=604800";
const TILE_FALLBACK_CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const TILE_FALLBACK_REFERER: &str = "https://map.osm.asia/";
const TILE_USER_AGENT: &str =
    "BetteriD/0.9.9-rc-1 (+https://map.osm.asia; contact=https://github.com/koharachan/BetteriD/issues)";
const LOGIN_MODAL_CSS: &str = include_str!("../web/login-modal.css");
const LOGIN_MODAL_JS: &str = include_str!("../web/login-modal.js");
const LOGIN_MODAL_TEMPLATE: &str = include_str!("../web/login-modal.html");
const MIRROR_NOTICE_CSS: &str = include_str!("../web/mirror-notice.css");
const MIRROR_NOTICE_JS: &str = include_str!("../web/mirror-notice.js");
const MIRROR_NOTICE_TEMPLATE: &str = include_str!("../web/mirror-notice.html");
const OAUTH_START_TEMPLATE: &str = include_str!("../web/oauth-start.html");
const TILE_SW_JS: &str = include_str!("../web/tile-sw.js");

#[derive(Clone)]
pub struct OsmProxy {
    client: ReqwestClient,
    cache: CacheHandle,
    translator: Option<Translator>,
    free_translator: FreeTranslator,
    ai_router: AiRouter,
    photo_store: PhotoStore,
    upstream_url: String,
    tile_upstream_url: String,
    static_dir: PathBuf,
    oauth_client_id: String,
    oauth_redirect_uri: Option<String>,
    trusted_proxy_ips: Arc<HashSet<IpAddr>>,
    rate_limits: Arc<Mutex<AiRateLimitState>>,
    ai_request_slots: Arc<Semaphore>,
    visual_request_slots: Arc<Semaphore>,
    proxy_all_tiles: bool,
    tile_proxy_base: String,
    privacy: PrivacyUploader,
}

struct AiRateLimitState {
    buckets: HashMap<IpAddr, VecDeque<Instant>>,
    last_cleanup: Instant,
}

impl Default for AiRateLimitState {
    fn default() -> Self {
        Self {
            buckets: HashMap::new(),
            last_cleanup: Instant::now(),
        }
    }
}

#[derive(Deserialize)]
struct TranslateApiRequest {
    text: String,
    target_langs: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_provider_order")]
    provider_order: Vec<String>,
}

#[derive(Deserialize)]
struct SummaryApiRequest {
    summary: Value,
    #[serde(default, deserialize_with = "deserialize_provider_order")]
    provider_order: Vec<String>,
}

#[derive(Deserialize)]
struct PrivacyUploadApiRequest {
    #[serde(default)]
    comment: String,
    #[serde(default)]
    tags: HashMap<String, String>,
    #[serde(rename = "osmChange")]
    osm_change: String,
}

impl OsmProxy {
    pub fn new(
        cache: CacheHandle,
        translator: Option<Translator>,
        ai_router: AiRouter,
        upstream_url: String,
        tile_upstream_url: String,
        static_dir: PathBuf,
        oauth_client_id: String,
        oauth_redirect_uri: Option<String>,
        photo_upload_dir: PathBuf,
        trusted_proxy_ips: Vec<IpAddr>,
        proxy_all_tiles: bool,
        tile_proxy_base: String,
        privacy: PrivacyUploader,
    ) -> Self {
        let client = ReqwestClient::builder()
            .redirect(reqwest::redirect::Policy::none())
            .gzip(true)
            .brotli(true)
            .deflate(true)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to create HTTP client");

        Self {
            client,
            cache,
            translator,
            free_translator: FreeTranslator::new(),
            ai_router,
            photo_store: PhotoStore::new(photo_upload_dir),
            upstream_url,
            tile_upstream_url,
            static_dir,
            oauth_client_id,
            oauth_redirect_uri,
            trusted_proxy_ips: Arc::new(trusted_proxy_ips.into_iter().collect()),
            rate_limits: Arc::new(Mutex::new(AiRateLimitState::default())),
            ai_request_slots: Arc::new(Semaphore::new(AI_MAX_CONCURRENT_REQUESTS)),
            visual_request_slots: Arc::new(Semaphore::new(AI_MAX_CONCURRENT_VISUAL_REQUESTS)),
            proxy_all_tiles,
            tile_proxy_base,
            privacy,
        }
    }

    async fn forward_request(
        &self,
        req: Request<HyperBody>,
        remote_ip: IpAddr,
    ) -> Result<Response<HyperBody>, hyper::Error> {
        let method = req.method().clone();
        let path = req.uri().path().to_string();

        if path == "/betterid/login-modal.css" {
            return Ok(Self::serve_embedded_asset(
                &method,
                "text/css; charset=utf-8",
                LOGIN_MODAL_CSS,
            ));
        }
        if path == "/betterid/login-modal.js" {
            return Ok(Self::serve_embedded_asset(
                &method,
                "application/javascript; charset=utf-8",
                LOGIN_MODAL_JS,
            ));
        }
        if path == "/betterid/mirror-notice.css" {
            return Ok(Self::serve_embedded_asset(
                &method,
                "text/css; charset=utf-8",
                MIRROR_NOTICE_CSS,
            ));
        }
        if path == "/betterid/mirror-notice.js" {
            return Ok(Self::serve_embedded_asset(
                &method,
                "application/javascript; charset=utf-8",
                MIRROR_NOTICE_JS,
            ));
        }
        if path == "/betterid/tile-sw.js" {
            let mut response = Self::serve_embedded_asset(
                &method,
                "application/javascript; charset=utf-8",
                TILE_SW_JS,
            );
            response
                .headers_mut()
                .insert("service-worker-allowed", HeaderValue::from_static("/"));
            return Ok(response);
        }
        if path == "/id/oauth/start" {
            return Ok(self.serve_oauth_start(&method));
        }
        if path.starts_with("/api/osm-ai/") {
            return Ok(self.handle_ai_request(req, remote_ip).await);
        }

        if path == "/id" {
            return Ok(Self::redirect("/id/"));
        }
        if path == "/id/" {
            return Ok(self.serve_id_index(&method).await);
        }
        if matches!(path.as_str(), "/id/land.html" | "/callback") {
            return Ok(self.serve_id_landing(&method).await);
        }
        if let Some(relative) = path.strip_prefix("/id/dist/") {
            let query = req.uri().query().map(str::to_string);
            return Ok(self
                .serve_static_file(relative, &method, req.headers(), query.as_deref())
                .await);
        }
        if matches!(path.as_str(), "/edit" | "/editor" | "/iD") {
            return Ok(Self::serve_editor_bridge(&method));
        }

        if path == "/tile/proxy" && self.proxy_all_tiles {
            let headers = req.headers().clone();
            let url = req.uri().query().and_then(|query| {
                form_urlencoded::parse(query.as_bytes())
                    .find_map(|(key, value)| (key == "url").then(|| value.into_owned()))
            });
            return Ok(match url {
                Some(url) => self.serve_proxied_tile(&method, &headers, &url).await,
                None => Self::empty_response(StatusCode::BAD_REQUEST),
            });
        }

        let query = req.uri().query().map(str::to_string);
        if !self.should_cache(&method, &path) {
            return self.proxy_without_cache(req).await;
        }

        let cache_key = query
            .as_ref()
            .map(|query| format!("{path}?{query}"))
            .unwrap_or_else(|| path.clone());

        if let Some(entry) = self.cache.get(&cache_key).await {
            info!("Cache hit for {}", cache_key);
            return Ok(self.build_cache_response(entry));
        }

        info!("Cache miss for {}", cache_key);
        let mut response = self.proxy_without_cache(req).await?;
        let headers = response.headers().clone();
        let status = response.status();
        let body = hyper::body::to_bytes(response.body_mut()).await?;
        if self.should_cache_response(&response) {
            let ttl = if path.starts_with("/tile/") {
                Self::tile_cache_ttl(&headers)
            } else {
                self.cache.get_ttl(&path)
            };
            let entry = CacheEntry {
                body: body.clone(),
                headers: headers.clone(),
                status,
                created_at: Instant::now(),
                ttl,
            };
            self.cache.set(&cache_key, entry.clone()).await;
            return Ok(self.build_cache_response(entry));
        }
        let mut builder = Response::builder().status(status);
        for (key, value) in &headers {
            builder = builder.header(key, value);
        }
        Ok(builder.body(HyperBody::from(body)).expect("valid response"))
    }

    async fn handle_ai_request(
        &self,
        req: Request<HyperBody>,
        remote_ip: IpAddr,
    ) -> Response<HyperBody> {
        let path = req.uri().path().to_string();
        if req.method() == Method::GET
            && let Some(id) = path
                .strip_prefix("/api/osm-ai/photos/")
                .and_then(|value| value.strip_suffix(".jpg"))
        {
            return self.serve_public_photo(id).await;
        }

        if !Self::same_origin(&req) {
            return Self::json_response(
                StatusCode::FORBIDDEN,
                serde_json::json!({
                    "error": "Cross-origin requests are not allowed"
                }),
            );
        }

        if path == "/api/osm-ai/status" && req.method() == Method::GET {
            return Self::json_response(
                StatusCode::OK,
                serde_json::json!({
                    "ai": self.ai_router.text_configured(),
                    "translate": true,
                    "search": self.ai_router.search_configured(),
                    "visual": self.ai_router.visual_configured(),
                    "privacy": self.privacy.configured(),
                    "providers": self.ai_router.configured_providers()
                }),
            );
        }

        if req.method() != Method::POST {
            return Self::json_response(
                StatusCode::METHOD_NOT_ALLOWED,
                serde_json::json!({
                    "error": "POST required"
                }),
            );
        }
        let client_ip = self.effective_client_ip(req.headers(), remote_ip);
        if !self.allow_ai_request(client_ip).await {
            return Self::json_response(
                StatusCode::TOO_MANY_REQUESTS,
                serde_json::json!({
                    "error": "Rate limit exceeded"
                }),
            );
        }
        let _ai_request_permit = match self.ai_request_slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                return Self::json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    serde_json::json!({ "error": "AI service is busy" }),
                );
            }
        };
        let visual_request = matches!(
            path.as_str(),
            "/api/osm-ai/photo-upload"
                | "/api/osm-ai/photos/upload"
                | "/api/osm-ai/photo-analyze"
                | "/api/osm-ai/photos/analyze"
        );
        let _visual_request_permit = if visual_request {
            match self.visual_request_slots.clone().try_acquire_owned() {
                Ok(permit) => Some(permit),
                Err(_) => {
                    return Self::json_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        serde_json::json!({ "error": "Visual AI service is busy" }),
                    );
                }
            }
        } else {
            None
        };

        let body_limit = match path.as_str() {
            "/api/osm-ai/photo-upload" | "/api/osm-ai/photos/upload" => MAX_PHOTO_BODY,
            "/api/osm-ai/privacy/upload" => PRIVACY_BODY_LIMIT,
            _ => AI_BODY_LIMIT,
        };
        let body = match Self::read_body_limited(req.into_body(), body_limit).await {
            Ok(body) => body,
            Err(status) => {
                return Self::json_response(
                    status,
                    serde_json::json!({
                        "error": "Invalid or oversized request body"
                    }),
                );
            }
        };

        match path.as_str() {
            "/api/osm-ai/translate" => self.handle_translate(&body).await,
            "/api/osm-ai/summarize" => self.handle_summarize(&body).await,
            "/api/osm-ai/tag-suggestions" => self.handle_tag_suggestions(&body).await,
            "/api/osm-ai/photo-upload" | "/api/osm-ai/photos/upload" => {
                self.handle_photo_upload(&body).await
            }
            "/api/osm-ai/photo-analyze" | "/api/osm-ai/photos/analyze" => {
                self.handle_photo_analyze(&body).await
            }
            "/api/osm-ai/privacy/upload" => self.handle_privacy_upload(&body).await,
            _ => Self::json_response(
                StatusCode::NOT_FOUND,
                serde_json::json!({
                    "error": "Not found"
                }),
            ),
        }
    }

    async fn handle_privacy_upload(&self, body: &[u8]) -> Response<HyperBody> {
        let Ok(request) = serde_json::from_slice::<PrivacyUploadApiRequest>(body) else {
            return Self::json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": "Invalid privacy upload request" }),
            );
        };

        if !self.privacy.configured() {
            return Self::json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({
                    "error": "Privacy upload is not configured on this server"
                }),
            );
        }

        let extra_tags: Vec<(String, String)> = request
            .tags
            .into_iter()
            .filter(|(key, _)| !key.trim().is_empty())
            .collect();

        match self
            .privacy
            .upload(&request.comment, &extra_tags, &request.osm_change)
            .await
        {
            Ok(result) => Self::json_response(
                StatusCode::OK,
                serde_json::json!({
                    "changeset": result.changeset,
                    "url": result.url,
                    "created": result.created,
                    "modified": result.modified,
                    "deleted": result.deleted
                }),
            ),
            Err(PrivacyError::InvalidRequest(message)) => Self::json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": message }),
            ),
            Err(err) => {
                error!("Privacy upload failed: {}", err.message());
                Self::json_response(
                    StatusCode::BAD_GATEWAY,
                    serde_json::json!({ "error": err.message() }),
                )
            }
        }
    }

    async fn handle_translate(&self, body: &[u8]) -> Response<HyperBody> {
        let Ok(request) = serde_json::from_slice::<TranslateApiRequest>(body) else {
            return Self::json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "error": "Invalid translation request"
                }),
            );
        };

        let text = request.text.trim();
        if text.is_empty()
            || text.chars().count() > 4000
            || request.target_langs.is_empty()
            || request.target_langs.len() > 8
            || request
                .target_langs
                .iter()
                .any(|lang| !Self::valid_bcp47(lang))
        {
            return Self::json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "error": "Invalid translation text"
                }),
            );
        }
        if self.ai_router.text_configured()
            && let Ok(translations) = self
                .ai_router
                .translate(text, &request.target_langs, &request.provider_order)
                .await
        {
            return Self::json_response(
                StatusCode::OK,
                serde_json::json!({ "translations": translations }),
            );
        }

        if let Some(translator) = &self.translator {
            let mut translations = Vec::new();
            for lang in &request.target_langs {
                if let Some(translated) = translator.translate(text, lang).await {
                    translations.push(serde_json::json!({ "lang": lang, "text": translated }));
                } else {
                    translations.clear();
                    break;
                }
            }
            if !translations.is_empty() {
                return Self::json_response(
                    StatusCode::OK,
                    serde_json::json!({ "translations": translations }),
                );
            }
        }

        if request
            .target_langs
            .iter()
            .all(|lang| matches!(lang.as_str(), "zh" | "zh-Hant" | "en"))
            && let Some(result) = self.free_translator.translate_three(text).await
        {
            let translations = request.target_langs.iter().filter_map(|lang| {
                let translated = match lang.as_str() {
                    "zh" => &result.zh_cn,
                    "zh-Hant" => &result.zh_tw,
                    "en" => &result.en,
                    _ => return None,
                };
                Some(serde_json::json!({ "lang": lang, "text": translated }))
            });
            return Self::json_response(
                StatusCode::OK,
                serde_json::json!({ "translations": translations.collect::<Vec<_>>() }),
            );
        }

        Self::json_response(
            StatusCode::BAD_GATEWAY,
            serde_json::json!({ "error": "Translation service request failed" }),
        )
    }

    async fn handle_summarize(&self, body: &[u8]) -> Response<HyperBody> {
        if !self.ai_router.text_configured() {
            return Self::json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({
                    "error": "AI service is not configured"
                }),
            );
        }
        let Ok(request) = serde_json::from_slice::<SummaryApiRequest>(body) else {
            return Self::json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "error": "Invalid summary request"
                }),
            );
        };
        if request.summary.to_string().len() > 12_000 {
            return Self::json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                serde_json::json!({
                    "error": "Summary is too large"
                }),
            );
        }

        match self
            .ai_router
            .summarize_changes(&request.summary, &request.provider_order)
            .await
        {
            Ok(summary) => {
                Self::json_response(StatusCode::OK, serde_json::json!({ "summary": summary }))
            }
            Err(err) => {
                error!("AI summary request failed: {}", err);
                Self::json_response(
                    StatusCode::BAD_GATEWAY,
                    serde_json::json!({
                        "error": "AI service request failed"
                    }),
                )
            }
        }
    }

    async fn handle_tag_suggestions(&self, body: &[u8]) -> Response<HyperBody> {
        let request = match serde_json::from_slice::<TagSuggestionRequest>(body) {
            Ok(request) => request,
            Err(_) => {
                return Self::json_response(
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({ "error": "Invalid tag suggestion request" }),
                );
            }
        };
        match self.ai_router.tag_suggestions(request).await {
            Ok(result) => Self::json_response(StatusCode::OK, serde_json::json!(result)),
            Err(TagSuggestionError::InvalidRequest(message)) => Self::json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": message }),
            ),
            Err(_) => Self::json_response(
                if self.ai_router.search_configured() {
                    StatusCode::BAD_GATEWAY
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                },
                serde_json::json!({ "error": "Tag suggestion service request failed" }),
            ),
        }
    }

    async fn handle_photo_upload(&self, body: &[u8]) -> Response<HyperBody> {
        let request = match serde_json::from_slice::<PhotoUploadRequest>(body) {
            Ok(request) => request,
            Err(_) => {
                return Self::json_response(
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({ "error": "Invalid photo upload request" }),
                );
            }
        };
        let provider_order = request.provider_order.clone();
        let processed =
            match tokio::task::spawn_blocking(move || decode_and_reencode(&request)).await {
                Ok(Ok(photo)) => photo,
                Ok(Err(message)) => {
                    return Self::json_response(
                        StatusCode::BAD_REQUEST,
                        serde_json::json!({ "error": message }),
                    );
                }
                Err(_) => {
                    return Self::json_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        serde_json::json!({ "error": "Photo processing failed" }),
                    );
                }
            };
        let moderation = match self
            .ai_router
            .moderate_photo(&processed.jpeg, &provider_order)
            .await
        {
            Ok(moderation) => moderation,
            Err(_) => {
                return Self::json_response(
                    if self.ai_router.visual_configured() {
                        StatusCode::BAD_GATEWAY
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    },
                    serde_json::json!({ "error": "Photo moderation service failed" }),
                );
            }
        };
        if !moderation.approved {
            return Self::json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                serde_json::json!({
                    "error": "Photo was rejected by the publication review",
                    "moderation": moderation
                }),
            );
        }
        let id = match self.photo_store.save(&processed.jpeg).await {
            Ok(id) => id,
            Err(message) => {
                return Self::json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    serde_json::json!({ "error": message }),
                );
            }
        };
        Self::json_response(
            StatusCode::CREATED,
            serde_json::json!({
                "approved": true,
                "id": id,
                "url": format!("/api/osm-ai/photos/{id}.jpg"),
                "width": processed.width,
                "height": processed.height,
                "mime_type": "image/jpeg"
            }),
        )
    }

    async fn handle_photo_analyze(&self, body: &[u8]) -> Response<HyperBody> {
        let request = match serde_json::from_slice::<PhotoAnalyzeRequest>(body) {
            Ok(request) => request,
            Err(_) => {
                return Self::json_response(
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({ "error": "Invalid photo analysis request" }),
                );
            }
        };
        if request.context.as_ref().is_some_and(|context| {
            serde_json::to_vec(context)
                .map(|encoded| encoded.len() > PHOTO_CONTEXT_MAX_BYTES)
                .unwrap_or(true)
                || !Self::valid_photo_context(context)
        }) {
            return Self::json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": "Invalid photo analysis context" }),
            );
        }
        let Some(id) =
            PhotoStore::id_from_reference(request.photo_id.as_deref(), request.url.as_deref())
        else {
            return Self::json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": "Only approved BetteriD photos can be analyzed" }),
            );
        };
        let jpeg = match self.photo_store.load(&id).await {
            Ok(jpeg) => jpeg,
            Err(_) => {
                return Self::json_response(
                    StatusCode::NOT_FOUND,
                    serde_json::json!({ "error": "Photo not found" }),
                );
            }
        };
        match self
            .ai_router
            .analyze_photo(&jpeg, request.context.as_ref(), &request.provider_order)
            .await
        {
            Ok(result) => {
                let suggestions = result
                    .suggestions
                    .into_iter()
                    .map(|suggestion| {
                        serde_json::json!({
                            "key": suggestion.key,
                            "value": suggestion.value,
                            "reason": { "zh": suggestion.reason_zh, "en": suggestion.reason_en },
                            "confidence": suggestion.confidence
                        })
                    })
                    .collect::<Vec<_>>();
                Self::json_response(
                    StatusCode::OK,
                    serde_json::json!({
                        "summary": { "zh": result.summary_zh, "en": result.summary_en },
                        "reasons": { "zh": result.reasons_zh, "en": result.reasons_en },
                        "suggestions": suggestions
                    }),
                )
            }
            Err(_) => Self::json_response(
                if self.ai_router.visual_configured() {
                    StatusCode::BAD_GATEWAY
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                },
                serde_json::json!({ "error": "Photo analysis service failed" }),
            ),
        }
    }

    async fn serve_public_photo(&self, id: &str) -> Response<HyperBody> {
        let jpeg = match self.photo_store.load(id).await {
            Ok(jpeg) => jpeg,
            Err(_) => return Self::empty_response(StatusCode::NOT_FOUND),
        };
        let mut response = Self::file_response(
            StatusCode::OK,
            "image/jpeg",
            jpeg,
            "public, max-age=31536000, immutable",
        );
        response
            .headers_mut()
            .insert("access-control-allow-origin", HeaderValue::from_static("*"));
        response
    }

    fn valid_bcp47(value: &str) -> bool {
        let value = value.trim();
        !value.is_empty()
            && value.len() <= 35
            && value.split('-').all(|part| {
                !part.is_empty()
                    && part.len() <= 8
                    && part
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
            })
    }

    fn valid_photo_context(context: &Value) -> bool {
        let Some(object) = context.as_object() else {
            return false;
        };
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "location" | "selected_tags"))
        {
            return false;
        }
        if let Some(location) = object.get("location") {
            let Some(coordinates) = location.as_array() else {
                return false;
            };
            if coordinates.len() != 2 {
                return false;
            }
            let (Some(lon), Some(lat)) = (coordinates[0].as_f64(), coordinates[1].as_f64()) else {
                return false;
            };
            if !lon.is_finite()
                || !lat.is_finite()
                || !(-180.0..=180.0).contains(&lon)
                || !(-90.0..=90.0).contains(&lat)
            {
                return false;
            }
        }
        if let Some(selected_tags) = object.get("selected_tags") {
            let Some(tags) = selected_tags.as_object() else {
                return false;
            };
            if tags.len() > 100
                || tags.iter().any(|(key, value)| {
                    key.is_empty()
                        || key.len() > 255
                        || value
                            .as_str()
                            .is_none_or(|value| value.chars().count() > 255)
                })
            {
                return false;
            }
        }
        true
    }

    fn effective_client_ip(&self, headers: &HeaderMap, peer_ip: IpAddr) -> IpAddr {
        if !self.trusted_proxy_ips.contains(&peer_ip) {
            return peer_ip;
        }
        let chain = if headers.contains_key("forwarded") {
            Self::parse_forwarded_chain(headers)
        } else if headers.contains_key("x-forwarded-for") {
            Self::parse_x_forwarded_for_chain(headers)
        } else {
            None
        };
        let Some(chain) = chain else {
            return peer_ip;
        };

        let mut current = peer_ip;
        for candidate in chain.into_iter().rev() {
            if !self.trusted_proxy_ips.contains(&current) {
                break;
            }
            current = candidate;
        }
        current
    }

    fn parse_forwarded_chain(headers: &HeaderMap) -> Option<Vec<IpAddr>> {
        let mut chain = Vec::new();
        for header in headers.get_all("forwarded") {
            let value = header.to_str().ok()?;
            for element in value.split(',') {
                let raw = element.split(';').find_map(|parameter| {
                    let (name, value) = parameter.trim().split_once('=')?;
                    name.eq_ignore_ascii_case("for").then_some(value.trim())
                })?;
                chain.push(Self::parse_forwarded_ip(raw)?);
            }
        }
        (!chain.is_empty()).then_some(chain)
    }

    fn parse_x_forwarded_for_chain(headers: &HeaderMap) -> Option<Vec<IpAddr>> {
        let mut chain = Vec::new();
        for header in headers.get_all("x-forwarded-for") {
            let value = header.to_str().ok()?;
            for raw in value.split(',') {
                chain.push(Self::parse_forwarded_ip(raw.trim())?);
            }
        }
        (!chain.is_empty()).then_some(chain)
    }

    fn parse_forwarded_ip(raw: &str) -> Option<IpAddr> {
        let raw = raw.trim().trim_matches('"');
        if raw.eq_ignore_ascii_case("unknown") || raw.starts_with('_') {
            return None;
        }
        raw.parse::<IpAddr>()
            .ok()
            .or_else(|| raw.parse::<SocketAddr>().ok().map(|address| address.ip()))
            .or_else(|| {
                raw.strip_prefix('[')
                    .and_then(|value| value.strip_suffix(']'))
                    .and_then(|value| value.parse().ok())
            })
    }

    async fn allow_ai_request(&self, remote_ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut state = self.rate_limits.lock().await;
        if now.duration_since(state.last_cleanup) >= AI_RATE_WINDOW {
            state.buckets.retain(|_, requests| {
                while requests
                    .front()
                    .is_some_and(|time| now.duration_since(*time) > AI_RATE_WINDOW)
                {
                    requests.pop_front();
                }
                !requests.is_empty()
            });
            state.last_cleanup = now;
        }
        if !state.buckets.contains_key(&remote_ip) && state.buckets.len() >= AI_RATE_BUCKET_LIMIT {
            return false;
        }
        let requests = state.buckets.entry(remote_ip).or_default();
        while requests
            .front()
            .is_some_and(|time| now.duration_since(*time) > AI_RATE_WINDOW)
        {
            requests.pop_front();
        }
        if requests.len() >= AI_RATE_LIMIT {
            return false;
        }
        requests.push_back(now);
        true
    }

    fn same_origin(req: &Request<HyperBody>) -> bool {
        let Some(origin) = req
            .headers()
            .get("origin")
            .and_then(|value| value.to_str().ok())
        else {
            return true;
        };
        let Some(host) = req
            .headers()
            .get("host")
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        let Ok(url) = Url::parse(origin) else {
            return false;
        };
        let origin_host = match url.port() {
            Some(port) => format!("{}:{}", url.host_str().unwrap_or_default(), port),
            None => url.host_str().unwrap_or_default().to_string(),
        };
        origin_host.eq_ignore_ascii_case(host)
    }

    async fn read_body_limited(mut body: HyperBody, limit: usize) -> Result<Vec<u8>, StatusCode> {
        let mut bytes = BytesMut::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|_| StatusCode::BAD_REQUEST)?;
            if bytes.len() + chunk.len() > limit {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes.to_vec())
    }

    fn editor_bridge_html() -> &'static str {
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="robots" content="noindex"><title>OpenStreetMap iD</title></head>
<body>
<script>
(() => {
  const source = new URL(window.location.href);
  const hash = new URLSearchParams(source.hash.replace(/^#/, ''));
  const query = source.searchParams;

  const zoom = query.get('zoom');
  const lat = query.get('lat');
  const lon = query.get('lon');
  if (zoom && lat && lon) hash.set('map', `${zoom}/${lat}/${lon}`);

  for (const [key, prefix] of [['node', 'n'], ['way', 'w'], ['relation', 'r']]) {
    const value = query.get(key);
    if (value) hash.set('id', prefix + value);
  }

  for (const key of ['locale', 'comment', 'hashtags', 'source', 'notes']) {
    const value = query.get(key);
    if (value) hash.set(key, value);
  }

  hash.delete('layer');
  hash.set('background', 'EsriWorldImagery');
  window.location.replace('/id/#' + hash.toString());
})();
</script>
</body>
</html>"#
    }

    fn serve_editor_bridge(method: &Method) -> Response<HyperBody> {
        if method != Method::GET && method != Method::HEAD {
            return Self::empty_response(StatusCode::METHOD_NOT_ALLOWED);
        }
        Self::file_response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            if method == Method::HEAD {
                Vec::new()
            } else {
                Self::editor_bridge_html().as_bytes().to_vec()
            },
            "no-store",
        )
    }

    fn serve_embedded_asset(
        method: &Method,
        content_type: &str,
        content: &str,
    ) -> Response<HyperBody> {
        if method != Method::GET && method != Method::HEAD {
            return Self::empty_response(StatusCode::METHOD_NOT_ALLOWED);
        }
        Self::file_response(
            StatusCode::OK,
            content_type,
            if method == Method::HEAD {
                Vec::new()
            } else {
                content.as_bytes().to_vec()
            },
            "no-store",
        )
    }

    fn serve_oauth_start(&self, method: &Method) -> Response<HyperBody> {
        if method != Method::GET && method != Method::HEAD {
            return Self::empty_response(StatusCode::METHOD_NOT_ALLOWED);
        }
        Self::file_response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            if method == Method::HEAD {
                Vec::new()
            } else {
                self.oauth_start_html().into_bytes()
            },
            "no-store",
        )
    }

    fn oauth_start_html(&self) -> String {
        let client_id =
            serde_json::to_string(&self.oauth_client_id).unwrap_or_else(|_| "\"\"".to_string());
        let official_origin = serde_json::to_string(self.upstream_url.trim_end_matches('/'))
            .unwrap_or_else(|_| "\"https://www.openstreetmap.org\"".to_string());
        let redirect_uri =
            serde_json::to_string(&self.oauth_redirect_uri).unwrap_or_else(|_| "null".to_string());

        OAUTH_START_TEMPLATE
            .replace("__BETTERID_OAUTH_CLIENT_ID__", &client_id)
            .replace("__BETTERID_OSM_ORIGIN__", &official_origin)
            .replace("__BETTERID_OAUTH_REDIRECT_URI__", &redirect_uri)
    }

    async fn serve_id_index(&self, method: &Method) -> Response<HyperBody> {
        if method != Method::GET && method != Method::HEAD {
            return Self::empty_response(StatusCode::METHOD_NOT_ALLOWED);
        }
        let index_path = self
            .static_dir
            .parent()
            .unwrap_or(Path::new("."))
            .join("index.html");
        let Ok(mut html) = tokio::fs::read_to_string(index_path).await else {
            return Self::text_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "iD build is not available",
            );
        };

        let asset_version = tokio::fs::metadata(self.static_dir.join("iD.min.js"))
            .await
            .and_then(|metadata| metadata.modified())
            .unwrap_or_else(|_| SystemTime::now())
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs());
        html = html.replace("__BETTERID_ASSET_VERSION__", &asset_version.to_string());
        html = html.replace("dist/iD.js?v=", "dist/iD.min.js?v=");
        let runtime_config = self.id_runtime_config(asset_version);
        let sw_snippet = if self.proxy_all_tiles {
            if self.tile_proxy_base.is_empty() {
                "<script>if('serviceWorker'in navigator)navigator.serviceWorker.register('/betterid/tile-sw.js',{scope:'/'});</script>".to_string()
            } else {
                // a dedicated tile host: the worker falls back to this origin
                // whenever that host is unreachable
                let base = self
                    .tile_proxy_base
                    .replace(':', "%3A")
                    .replace('/', "%2F");
                format!(
                    "<script>if('serviceWorker'in navigator)navigator.serviceWorker.register('/betterid/tile-sw.js?base={base}',{{scope:'/'}});</script>"
                )
            }
        } else {
            String::new()
        };
        html = html.replace("</head>", &format!("{runtime_config}{sw_snippet}</head>"));
        Self::file_response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            if method == Method::HEAD {
                Vec::new()
            } else {
                html.into_bytes()
            },
            "no-cache",
        )
    }

    fn id_runtime_config(&self, asset_version: u64) -> String {
        let oauth_origin = serde_json::to_string(self.upstream_url.trim_end_matches('/'))
            .unwrap_or_else(|_| "\"https://www.openstreetmap.org\"".to_string());
        let client_id =
            serde_json::to_string(&self.oauth_client_id).unwrap_or_else(|_| "\"\"".to_string());
        let redirect_uri =
            serde_json::to_string(&self.oauth_redirect_uri).unwrap_or_else(|_| "null".to_string());

        format!(
            "<script>window.OSM_PROXY_CONFIG={{assetVersion:{asset_version},osmApiConnection:{{url:{oauth_origin},apiUrl:window.location.origin,client_id:{client_id},redirect_uri:{redirect_uri}}}}};</script>"
        )
    }

    async fn serve_id_landing(&self, method: &Method) -> Response<HyperBody> {
        if method != Method::GET && method != Method::HEAD {
            return Self::empty_response(StatusCode::METHOD_NOT_ALLOWED);
        }

        let landing_path = self
            .static_dir
            .parent()
            .unwrap_or(Path::new("."))
            .join("land.html");
        let Ok(data) = tokio::fs::read(landing_path).await else {
            return Self::text_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "OAuth landing page is not available",
            );
        };

        Self::file_response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            if method == Method::HEAD {
                Vec::new()
            } else {
                data
            },
            "no-store",
        )
    }

    async fn serve_static_file(
        &self,
        relative: &str,
        method: &Method,
        headers: &HeaderMap,
        query: Option<&str>,
    ) -> Response<HyperBody> {
        if method != Method::GET && method != Method::HEAD {
            return Self::empty_response(StatusCode::METHOD_NOT_ALLOWED);
        }
        let relative_path = Path::new(relative);
        if relative_path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Self::empty_response(StatusCode::BAD_REQUEST);
        }
        let path = self.static_dir.join(relative_path);
        let Ok(data) = tokio::fs::read(&path).await else {
            return Self::empty_response(StatusCode::NOT_FOUND);
        };
        let content_type = Self::content_type(&path);
        let data = if method == Method::HEAD {
            Vec::new()
        } else {
            self.rewrite_urls(&data, content_type, &format!("/id/dist/{relative}"), None)
        };

        let (data, encoding) = if method == Method::HEAD {
            (data, None)
        } else {
            Self::maybe_compress(data, content_type, headers)
        };

        // iD requests its build outputs with a `?v=<build>` cache buster, so a
        // versioned asset can be cached for a long time (the CDN keeps js/css
        // even longer); everything else stays on the short default.
        // Cache lifetime by asset kind:
        //   - `?v=<build>` assets are content-addressed by the cache buster, so
        //     they can be cached for a week and marked immutable
        //   - the vendored preset / name-suggestion-index data is fetched without
        //     a version, so it gets a day (the CDN's own json rule is longer, but
        //     it honours this header)
        //   - everything else keeps the short default
        let versioned = query
            .map(|value| value.split('&').any(|pair| pair.starts_with("v=")))
            .unwrap_or(false);
        let cache_control = if versioned {
            "public, max-age=604800, immutable"
        } else if relative.starts_with("nsi/") || relative.starts_with("tagging-schema/") {
            "public, max-age=86400"
        } else {
            "public, max-age=3600"
        };

        Self::file_response_encoded(StatusCode::OK, content_type, data, cache_control, encoding)
    }

    fn content_type(path: &Path) -> &'static str {
        match path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
        {
            "css" => "text/css; charset=utf-8",
            "html" => "text/html; charset=utf-8",
            "js" => "application/javascript; charset=utf-8",
            "json" => "application/json; charset=utf-8",
            "map" => "application/json; charset=utf-8",
            "png" => "image/png",
            "svg" => "image/svg+xml",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            _ => "application/octet-stream",
        }
    }

    fn redirect(location: &str) -> Response<HyperBody> {
        Response::builder()
            .status(StatusCode::TEMPORARY_REDIRECT)
            .header("location", location)
            .header("cache-control", "no-cache")
            .body(HyperBody::empty())
            .expect("valid redirect response")
    }

    fn json_response(status: StatusCode, data: Value) -> Response<HyperBody> {
        Self::file_response(
            status,
            "application/json; charset=utf-8",
            serde_json::to_vec(&data).unwrap_or_default(),
            "no-store",
        )
    }

    fn text_response(status: StatusCode, text: &str) -> Response<HyperBody> {
        Self::file_response(
            status,
            "text/plain; charset=utf-8",
            text.as_bytes().to_vec(),
            "no-store",
        )
    }

    fn empty_response(status: StatusCode) -> Response<HyperBody> {
        Response::builder()
            .status(status)
            .body(HyperBody::empty())
            .expect("valid empty response")
    }

    fn file_response(
        status: StatusCode,
        content_type: &str,
        data: Vec<u8>,
        cache_control: &str,
    ) -> Response<HyperBody> {
        Self::file_response_encoded(status, content_type, data, cache_control, None)
    }

    fn file_response_encoded(
        status: StatusCode,
        content_type: &str,
        data: Vec<u8>,
        cache_control: &str,
        content_encoding: Option<&'static str>,
    ) -> Response<HyperBody> {
        let mut builder = Response::builder()
            .status(status)
            .header("content-type", content_type)
            .header("cache-control", cache_control)
            .header("content-length", data.len())
            .header("x-content-type-options", "nosniff");
        if let Some(encoding) = content_encoding {
            builder = builder
                .header("content-encoding", encoding)
                .header("vary", "Accept-Encoding");
        }
        builder
            .body(HyperBody::from(data))
            .expect("valid file response")
    }

    /// Preferred compression for a response body, based on `Accept-Encoding`.
    fn preferred_encoding(headers: &HeaderMap) -> Option<&'static str> {
        let value = headers
            .get(http::header::ACCEPT_ENCODING)
            .and_then(|item| item.to_str().ok())?;

        let accepts = |token: &str| {
            value.split(',').any(|part| {
                let mut pieces = part.split(';');
                let name = pieces.next().unwrap_or_default().trim();
                if !name.eq_ignore_ascii_case(token) {
                    return false;
                }
                let quality = pieces
                    .find_map(|piece| piece.trim().strip_prefix("q="))
                    .and_then(|raw| raw.trim().parse::<f32>().ok())
                    .unwrap_or(1.0);
                quality > 0.0
            })
        };

        if accepts("br") {
            Some("br")
        } else if accepts("gzip") {
            Some("gzip")
        } else {
            None
        }
    }

    fn brotli_compress(data: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut out = Vec::with_capacity(data.len() / 3 + 64);
        {
            // quality 5 keeps the origin's CPU cost low while still cutting
            // JavaScript by ~4x; the CDN caches the compressed variant anyway.
            let mut writer = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
            if writer.write_all(data).is_err() {
                return Vec::new();
            }
        }
        out
    }

    fn gzip_compress(data: &[u8]) -> Vec<u8> {
        use flate2::Compression;
        use flate2::write::GzEncoder;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::with_capacity(data.len() / 3 + 64), Compression::new(6));
        if encoder.write_all(data).is_err() {
            return Vec::new();
        }
        encoder.finish().unwrap_or_default()
    }

    /// Compress a static asset for the client, so the CDN pulls fewer bytes from
    /// the origin. Compressed variants are cached by the edge (they are sent with
    /// `Vary: Accept-Encoding`).
    fn maybe_compress(
        data: Vec<u8>,
        content_type: &str,
        headers: &HeaderMap,
    ) -> (Vec<u8>, Option<&'static str>) {
        let compressible = content_type.starts_with("text/")
            || content_type.starts_with("application/javascript")
            || content_type.starts_with("application/json")
            || content_type.starts_with("image/svg");
        if !compressible || data.len() < 1024 {
            return (data, None);
        }

        match Self::preferred_encoding(headers) {
            Some("br") => {
                let compressed = Self::brotli_compress(&data);
                if compressed.is_empty() || compressed.len() >= data.len() {
                    (data, None)
                } else {
                    (compressed, Some("br"))
                }
            }
            Some("gzip") => {
                let compressed = Self::gzip_compress(&data);
                if compressed.is_empty() || compressed.len() >= data.len() {
                    (data, None)
                } else {
                    (compressed, Some("gzip"))
                }
            }
            _ => (data, None),
        }
    }

    fn should_cache(&self, method: &Method, path: &str) -> bool {
        if method != Method::GET {
            return false;
        }
        path.starts_with("/tile/")
    }

    fn should_cache_response(&self, response: &Response<HyperBody>) -> bool {
        if response.status() != StatusCode::OK {
            return false;
        }
        if response.headers().contains_key("x-blocked") {
            return false;
        }
        if response.headers().contains_key("set-cookie") {
            return false;
        }
        if response
            .headers()
            .get("vary")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.split(',').any(|name| {
                    matches!(
                        name.trim().to_ascii_lowercase().as_str(),
                        "*" | "cookie" | "authorization"
                    )
                })
            })
        {
            return false;
        }
        !response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                let value = value.to_ascii_lowercase();
                [
                    "no-cache",
                    "no-store",
                    "private",
                    "must-revalidate",
                    "max-age=0",
                ]
                .iter()
                .any(|directive| value.contains(directive))
            })
    }

    fn apply_client_cache_policy(path: &str, response: &mut Response<HyperBody>) {
        if path.starts_with("/api/0.6/") || path == "/query-features" {
            response.headers_mut().insert(
                "cache-control",
                HeaderValue::from_static("no-store, no-cache, must-revalidate"),
            );
            response
                .headers_mut()
                .insert("pragma", HeaderValue::from_static("no-cache"));
            response
                .headers_mut()
                .insert("expires", HeaderValue::from_static("0"));
        } else if path.starts_with("/tile/") {
            if !response.headers().contains_key("cache-control") {
                response.headers_mut().insert(
                    "cache-control",
                    HeaderValue::from_static(TILE_FALLBACK_CACHE_CONTROL),
                );
            }
            response.headers_mut().remove("pragma");
            response.headers_mut().remove("expires");
            // Tiles can be served from a dedicated host (see `OSM_TILE_PROXY_BASE`),
            // so the editor fetches them cross-origin.
            if !response
                .headers()
                .contains_key("access-control-allow-origin")
            {
                response.headers_mut().insert(
                    "access-control-allow-origin",
                    HeaderValue::from_static("*"),
                );
            }
        }
    }

    fn tile_cache_ttl(headers: &HeaderMap) -> Duration {
        Self::tile_cache_ttl_from_values(
            headers
                .get_all("cache-control")
                .iter()
                .filter_map(|value| value.to_str().ok()),
        )
    }

    fn reqwest_tile_cache_ttl(headers: &reqwest::header::HeaderMap) -> Duration {
        Self::tile_cache_ttl_from_values(
            headers
                .get_all("cache-control")
                .iter()
                .filter_map(|value| value.to_str().ok()),
        )
    }

    fn tile_cache_ttl_from_values<'a>(values: impl Iterator<Item = &'a str>) -> Duration {
        values
            .filter_map(Self::cache_control_max_age)
            .max()
            .map(Duration::from_secs)
            .unwrap_or(TILE_FALLBACK_CACHE_TTL)
    }

    fn cache_control_max_age(cache_control: &str) -> Option<u64> {
        let mut max_age = None;
        let mut shared_max_age = None;
        for directive in cache_control.split(',') {
            let Some((name, value)) = directive.trim().split_once('=') else {
                continue;
            };
            let value = value.trim().trim_matches('"');
            let Ok(seconds) = value.parse::<u64>() else {
                continue;
            };
            match name.trim().to_ascii_lowercase().as_str() {
                "max-age" => max_age = Some(seconds),
                "s-maxage" => shared_max_age = Some(seconds),
                _ => {}
            }
        }
        shared_max_age.or(max_age)
    }

    fn is_osm_tile_service_url(url: &Url) -> bool {
        url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("tile.openstreetmap.org")
                || host.eq_ignore_ascii_case("gps.tile.openstreetmap.org")
                || host.eq_ignore_ascii_case("gps-tile.openstreetmap.org")
                || host
                    .to_ascii_lowercase()
                    .ends_with(".gps-tile.openstreetmap.org")
        })
    }

    fn tile_referer(headers: &HeaderMap) -> String {
        headers
            .get("referer")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(TILE_FALLBACK_REFERER)
            .to_string()
    }

    fn build_cache_response(&self, entry: CacheEntry) -> Response<HyperBody> {
        let mut response = Response::new(HyperBody::from(entry.body));
        *response.status_mut() = entry.status;
        for (key, value) in &entry.headers {
            response.headers_mut().insert(key, value.clone());
        }
        response
            .headers_mut()
            .insert("x-cache", HeaderValue::from_static("hit"));
        response
    }

    async fn build_upstream_url(
        &self,
        path: &str,
        query: Option<&str>,
    ) -> Result<Url, url::ParseError> {
        let (base_url, stripped_path) = if path.starts_with("/tile/arcgis/") {
            (
                "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile",
                &path["/tile/arcgis".len()..],
            )
        } else if path.starts_with("/tile/lines/") {
            (
                "https://gps.tile.openstreetmap.org",
                &path["/tile/lines".len()..],
            )
        } else if path.starts_with("/tile/") {
            (self.tile_upstream_url.as_str(), &path["/tile".len()..])
        } else if path.starts_with("/avatar-s3/") {
            (
                "https://openstreetmap-user-avatars.s3.dualstack.eu-west-1.amazonaws.com",
                &path["/avatar-s3".len()..],
            )
        } else if path.starts_with("/gravatar/") {
            ("https://www.gravatar.com", &path["/gravatar".len()..])
        } else if path == "/query-features" {
            ("https://query.openstreetmap.org", path)
        } else {
            (self.upstream_url.as_str(), path)
        };

        let mut url = Url::parse(&format!("{base_url}{stripped_path}"))?;
        if let Some(query) = query {
            url.set_query(Some(query));
        }
        Ok(url)
    }

    async fn proxy_without_cache(
        &self,
        req: Request<HyperBody>,
    ) -> Result<Response<HyperBody>, hyper::Error> {
        let path = req.uri().path().to_string();
        let query = req.uri().query().map(str::to_string);
        let upstream_url = match self.build_upstream_url(&path, query.as_deref()).await {
            Ok(url) => url,
            Err(err) => {
                error!("Invalid upstream URL: {}", err);
                return Ok(Self::text_response(
                    StatusCode::BAD_REQUEST,
                    "Invalid upstream URL",
                ));
            }
        };

        let method = req.method().clone();
        let headers = req.headers().clone();
        let body = hyper::body::to_bytes(req.into_body()).await?;
        debug!("Forwarding {} to {}", method, upstream_url);

        let reqwest_method =
            reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
        let forwards_private_headers = upstream_url
            .as_str()
            .starts_with(self.upstream_url.trim_end_matches('/'));
        let is_osm_tile_service = Self::is_osm_tile_service_url(&upstream_url);
        let mut request_builder = self
            .client
            .request(reqwest_method, upstream_url.as_str())
            .body(body.to_vec());

        for (key, value) in &headers {
            let key_lower = key.as_str().to_ascii_lowercase();
            if matches!(
                key_lower.as_str(),
                "host" | "content-length" | "origin" | "referer"
            ) {
                continue;
            }
            if is_osm_tile_service
                && matches!(
                    key_lower.as_str(),
                    "user-agent" | "cache-control" | "pragma"
                )
            {
                continue;
            }
            if !forwards_private_headers && key_lower == "authorization" {
                continue;
            }
            if !forwards_private_headers && key_lower == "cookie" {
                if path == "/query-features"
                    && let Ok(cookie) = value.to_str()
                    && let Some(token) = Self::query_service_cookie(cookie)
                {
                    request_builder = request_builder.header("cookie", token);
                }
                continue;
            }
            request_builder = request_builder.header(key.as_str(), value.as_bytes());
        }
        if is_osm_tile_service {
            request_builder = request_builder
                .header("user-agent", TILE_USER_AGENT)
                .header("referer", Self::tile_referer(&headers));
        } else if headers.contains_key("origin") {
            request_builder = request_builder.header("origin", &self.upstream_url);
        }
        if !is_osm_tile_service && headers.contains_key("referer") {
            request_builder =
                request_builder.header("referer", format!("{}{}", self.upstream_url, path));
        }
        if let Some(host) = upstream_url.host_str() {
            request_builder = request_builder.header("host", host);
        }

        match request_builder.send().await {
            Ok(response) => {
                let status = StatusCode::from_u16(response.status().as_u16())
                    .unwrap_or(StatusCode::BAD_GATEWAY);
                let response_headers = response.headers().clone();
                let content_type = response_headers
                    .get("content-type")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                let bytes = response.bytes().await.unwrap_or_default();
                let rewritten = self.rewrite_urls(&bytes, &content_type, &path, query.as_deref());
                let mut builder = Response::builder().status(status);

                for (key, value) in &response_headers {
                    let key_lower = key.as_str().to_ascii_lowercase();
                    if matches!(
                        key_lower.as_str(),
                        "content-encoding" | "content-length" | "transfer-encoding"
                    ) {
                        continue;
                    }
                    if key_lower == "set-cookie" {
                        if let Ok(cookie) = value.to_str() {
                            builder =
                                builder.header(key.as_str(), Self::clean_cookie_domain(cookie));
                        }
                        continue;
                    }
                    if key_lower == "location" {
                        if let Ok(location) = value.to_str() {
                            builder = builder.header(key.as_str(), self.rewrite_location(location));
                        }
                        continue;
                    }
                    if key_lower == "content-security-policy" {
                        if let Ok(policy) = value.to_str() {
                            builder = builder.header(
                                key.as_str(),
                                Self::rewrite_content_security_policy(policy),
                            );
                        }
                        continue;
                    }
                    builder = builder.header(key.as_str(), value.as_bytes());
                }

                let mut response = builder
                    .header("content-length", rewritten.len())
                    .header("x-proxy", "osm-proxy")
                    .body(HyperBody::from(rewritten))
                    .expect("valid upstream response");
                Self::apply_client_cache_policy(&path, &mut response);
                Ok(response)
            }
            Err(err) => {
                error!("Failed to proxy request: {}", err);
                Ok(Self::text_response(
                    StatusCode::BAD_GATEWAY,
                    "Upstream request failed",
                ))
            }
        }
    }

    fn rewrite_content_security_policy(policy: &str) -> String {
        policy
            .split(';')
            .map(|directive| {
                let directive = directive.trim();
                if directive.starts_with("img-src ")
                    && !directive
                        .split_ascii_whitespace()
                        .any(|source| source == "https://osm.asia")
                {
                    format!("{directive} https://osm.asia")
                } else {
                    directive.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn clean_cookie_domain(cookie: &str) -> String {
        cookie
            .split(';')
            .filter(|part| !part.trim().to_ascii_lowercase().starts_with("domain="))
            .collect::<Vec<_>>()
            .join(";")
    }

    fn query_service_cookie(cookie: &str) -> Option<String> {
        cookie
            .split(';')
            .map(str::trim)
            .find(|part| {
                part.split_once('=')
                    .is_some_and(|(name, _)| name == "_osm_totp_token")
            })
            .map(str::to_string)
    }

    fn rewrite_location(&self, location: &str) -> String {
        let upstream = self.upstream_url.trim_end_matches('/');
        location
            .replace(upstream, "")
            .replace("https://www.openstreetmap.org", "")
            .replace("http://www.openstreetmap.org", "")
            .replace("https://openstreetmap.org", "")
            .replace("http://openstreetmap.org", "")
            .replace(
                "https://openstreetmap-user-avatars.s3.dualstack.eu-west-1.amazonaws.com/",
                "/avatar-s3/",
            )
            .replace("https://www.gravatar.com/avatar/", "/gravatar/")
            .replace(
                "https://query.openstreetmap.org/query-features",
                "/query-features",
            )
    }

    fn rewrite_urls(
        &self,
        body: &[u8],
        content_type: &str,
        path: &str,
        query: Option<&str>,
    ) -> Vec<u8> {
        let is_text = content_type.starts_with("text/")
            || content_type.starts_with("application/javascript")
            || content_type.starts_with("application/json")
            || content_type.starts_with("application/x-javascript");
        if !is_text {
            return body.to_vec();
        }
        let Ok(text) = std::str::from_utf8(body) else {
            return body.to_vec();
        };
        let upstream = self.upstream_url.trim_end_matches('/');
        let rewritten = text
            .replace("https://tile.openstreetmap.org/", "/tile/")
            .replace("http://tile.openstreetmap.org/", "/tile/")
            .replace("//tile.openstreetmap.org/", "/tile/")
            .replace("https://gps.tile.openstreetmap.org/lines/", "/tile/lines/")
            .replace(
                "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/",
                "/tile/arcgis/",
            )
            .replace(&format!("{upstream}/"), "/")
            .replace("https://www.openstreetmap.org/", "/")
            .replace("http://www.openstreetmap.org/", "/")
            .replace(
                "https://openstreetmap-user-avatars.s3.dualstack.eu-west-1.amazonaws.com/",
                "/avatar-s3/",
            )
            .replace("https://www.gravatar.com/avatar/", "/gravatar/")
            .replace(
                "https://query.openstreetmap.org/query-features",
                "/query-features",
            )
            .to_string();

        // OSM serves fingerprinted JavaScript with a long immutable browser TTL.
        // Add our own version because the proxy rewrites the asset contents.
        let rewritten = if content_type.starts_with("text/html") {
            rewritten.replace(".js\"", ".js?betterid-proxy=1\"")
        } else {
            rewritten
        };

        let rewritten = self.inject_login_options(&rewritten, path, query);
        let rewritten = Self::rewrite_osm_branding(&rewritten, path);
        let rewritten = self.inject_root_login_modal(&rewritten, path);
        Self::inject_mirror_notice(&rewritten, path).into_bytes()
    }

    fn rewrite_osm_branding(html: &str, _path: &str) -> String {
        if !html.contains("osm_logo") && !html.contains("OpenStreetMap logo") {
            return html.to_string();
        }
        const BRAND_HTML: &str = "\n      <img alt=\"OSM.asia logo\" src=\"https://osm.asia/logo.jpg\" width=\"30\" height=\"30\">\n      OSM.asia\n    ";

        let mut rewritten = String::with_capacity(html.len());
        let mut cursor = 0;
        let mut search_start = 0;
        let mut changed = false;

        while let Some(anchor_start_rel) = html[search_start..].find("<a") {
            let anchor_start = search_start + anchor_start_rel;
            let Some(open_end) = html[anchor_start..].find('>').map(|i| anchor_start + i + 1)
            else {
                break;
            };
            let Some(close_start) = html[open_end..].find("</a>").map(|i| open_end + i) else {
                break;
            };
            let close_end = close_start + "</a>".len();
            let anchor = &html[anchor_start..close_end];

            if Self::is_osm_brand_anchor(anchor) {
                rewritten.push_str(&html[cursor..open_end]);
                rewritten.push_str(BRAND_HTML);
                rewritten.push_str(&html[close_start..close_end]);
                cursor = close_end;
                changed = true;
            }
            search_start = close_end;
        }

        if !changed {
            return html.to_string();
        }

        rewritten.push_str(&html[cursor..]);
        rewritten
    }

    fn is_osm_brand_anchor(anchor: &str) -> bool {
        let lower = anchor.to_ascii_lowercase();
        lower.contains("osm_logo")
            || lower.contains("openstreetmap logo")
            || lower.contains("openstreetmap_logo")
    }

    fn inject_mirror_notice(html: &str, path: &str) -> String {
        if path != "/"
            || html.contains("betterid-mirror-notice")
            || !html.contains("</head>")
            || !html.contains("</body>")
        {
            return html.to_string();
        }

        let with_styles = html.replacen(
            "</head>",
            "<link rel=\"stylesheet\" href=\"/betterid/mirror-notice.css\"></head>",
            1,
        );
        with_styles.replacen(
            "</body>",
            &format!(
                "{MIRROR_NOTICE_TEMPLATE}<script defer src=\"/betterid/mirror-notice.js\"></script></body>"
            ),
            1,
        )
    }

    fn inject_root_login_modal(&self, html: &str, path: &str) -> String {
        if path != "/"
            || html.contains("betterid-login-modal")
            || !html.contains("login-menu")
            || !html.contains("href=\"/login")
            || !html.contains("</head>")
            || !html.contains("</body>")
        {
            return html.to_string();
        }

        let is_chinese = html.contains("lang=\"zh") || html.contains("lang='zh");
        let labels = if is_chinese {
            [
                "选择登录方式",
                "选择适合你的方式登录 map.osm.asia。",
                "账号密码登录",
                "在当前站点输入 OpenStreetMap 账号和密码",
                "使用 OSM 官网授权登录",
                "登录 map.osm.asia，并授权 BetteriD 编辑器访问你的账号",
                "使用官网授权时，BetteriD 不会接触或保存你的密码",
                "关闭登录窗口",
            ]
        } else {
            [
                "Choose how to sign in",
                "Choose how you want to sign in to map.osm.asia.",
                "Sign in with password",
                "Enter your OpenStreetMap username and password on this site",
                "Sign in with OSM authorization",
                "Sign in to map.osm.asia and authorize the BetteriD editor",
                "When using OSM authorization, BetteriD never sees or stores your password",
                "Close sign-in dialog",
            ]
        };

        let modal = LOGIN_MODAL_TEMPLATE
            .replace("__BETTERID_LOGIN_TITLE__", labels[0])
            .replace("__BETTERID_LOGIN_DESCRIPTION__", labels[1])
            .replace("__BETTERID_PASSWORD_TITLE__", labels[2])
            .replace("__BETTERID_PASSWORD_DESCRIPTION__", labels[3])
            .replace("__BETTERID_OAUTH_TITLE__", labels[4])
            .replace("__BETTERID_OAUTH_DESCRIPTION__", labels[5])
            .replace("__BETTERID_PRIVACY_NOTE__", labels[6])
            .replace("__BETTERID_CLOSE_LABEL__", labels[7]);

        let with_styles = html.replacen(
            "</head>",
            "<link rel=\"stylesheet\" href=\"/betterid/login-modal.css\"></head>",
            1,
        );
        with_styles.replacen(
            "</body>",
            &format!("{modal}<script defer src=\"/betterid/login-modal.js\"></script></body>"),
            1,
        )
    }

    fn inject_login_options(&self, html: &str, path: &str, query: Option<&str>) -> String {
        if path != "/login" || html.contains("betterid-osm-auth-choice") {
            return html.to_string();
        }

        let Some(referer) = query.and_then(|query| {
            form_urlencoded::parse(query.as_bytes()).find_map(|(key, value)| {
                if key == "referer" {
                    Some(value.into_owned())
                } else {
                    None
                }
            })
        }) else {
            return html.to_string();
        };
        if !referer.starts_with("/oauth2/authorize?") {
            return html.to_string();
        }

        let upstream = self.upstream_url.trim_end_matches('/');
        let Ok(authorize_url) = Url::parse(&format!("{upstream}{referer}")) else {
            return html.to_string();
        };
        let uses_current_client = authorize_url
            .query_pairs()
            .any(|(key, value)| key == "client_id" && value == self.oauth_client_id.as_str());
        if authorize_url.path() != "/oauth2/authorize" || !uses_current_client {
            return html.to_string();
        }

        let official_url = Self::escape_html_attribute(authorize_url.as_str());
        let is_chinese = html.contains("lang=\"zh") || html.contains("lang='zh");
        let (official_label, password_label) = if is_chinese {
            ("使用 OpenStreetMap 官网授权登录", "或使用账号密码登录")
        } else {
            (
                "Authorize on the OpenStreetMap website",
                "or sign in with your username and password",
            )
        };
        let choices = format!(
            r#"<div id="betterid-osm-auth-choice" class="mb-3">
<a class="btn btn-success w-100 py-2" rel="nofollow" href="{official_url}">{official_label}</a>
<div class="d-flex align-items-center gap-2 my-3 text-body-secondary"><hr class="flex-grow-1 my-0"><span>{password_label}</span><hr class="flex-grow-1 my-0"></div>
</div>
"#
        );

        html.replacen(
            "<form id=\"login_form\"",
            &format!("{choices}<form id=\"login_form\""),
            1,
        )
    }

    fn escape_html_attribute(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('\'', "&#39;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    async fn serve_proxied_tile(
        &self,
        method: &Method,
        headers: &HeaderMap,
        tile_url: &str,
    ) -> Response<HyperBody> {
        if method != Method::GET && method != Method::HEAD {
            return Self::empty_response(StatusCode::METHOD_NOT_ALLOWED);
        }
        let Ok(parsed) = Url::parse(tile_url) else {
            return Self::empty_response(StatusCode::BAD_REQUEST);
        };
        if !matches!(parsed.scheme(), "http" | "https") {
            return Self::empty_response(StatusCode::BAD_REQUEST);
        }
        let Some(host) = parsed.host_str() else {
            return Self::empty_response(StatusCode::BAD_REQUEST);
        };
        if is_private_host(host) {
            return Self::empty_response(StatusCode::FORBIDDEN);
        }

        let cache_key = format!("ext:{tile_url}");
        if let Some(entry) = self.cache.get(&cache_key).await {
            return self.build_cache_response(entry);
        }

        let mut request = self.client.get(tile_url);
        if Self::is_osm_tile_service_url(&parsed) {
            request = request
                .header("user-agent", TILE_USER_AGENT)
                .header("referer", Self::tile_referer(headers));
        }
        let result = request.send().await;

        match result {
            Ok(response) => {
                let status = StatusCode::from_u16(response.status().as_u16())
                    .unwrap_or(StatusCode::BAD_GATEWAY);
                if !status.is_success() {
                    return Self::empty_response(status);
                }
                let response_headers = response.headers().clone();
                let content_type = response_headers
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("image/png")
                    .to_string();
                let tile_bytes = response.bytes().await.unwrap_or_default();
                let ttl = Self::reqwest_tile_cache_ttl(&response_headers);
                let mut headers = HeaderMap::new();
                let blocked_tile = response_headers.contains_key("x-blocked");
                for key in [
                    "content-type",
                    "cache-control",
                    "etag",
                    "expires",
                    "last-modified",
                    "x-blocked",
                ] {
                    if let Some(value) = response_headers
                        .get(key)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| HeaderValue::from_str(value).ok())
                    {
                        headers.insert(key, value);
                    }
                }
                if !headers.contains_key("content-type")
                    && let Ok(ct) = HeaderValue::from_str(&content_type)
                {
                    headers.insert("content-type", ct);
                }
                // a dedicated tile host (wap.map.osm.asia) is fetched cross-origin
                headers.insert(
                    "access-control-allow-origin",
                    HeaderValue::from_static("*"),
                );
                if blocked_tile {
                    headers.insert("cache-control", HeaderValue::from_static("no-store"));
                } else if !headers.contains_key("cache-control") {
                    headers.insert(
                        "cache-control",
                        HeaderValue::from_static(TILE_FALLBACK_CACHE_CONTROL),
                    );
                }
                if !blocked_tile {
                    let entry = CacheEntry {
                        body: tile_bytes.clone(),
                        headers: headers.clone(),
                        status,
                        created_at: Instant::now(),
                        ttl,
                    };
                    self.cache.set(&cache_key, entry).await;
                }
                let mut builder = Response::builder().status(status);
                for (key, value) in &headers {
                    builder = builder.header(key, value);
                }
                builder
                    .header(
                        "content-length",
                        if method == Method::HEAD {
                            0
                        } else {
                            tile_bytes.len()
                        },
                    )
                    .header("x-content-type-options", "nosniff")
                    .body(HyperBody::from(if method == Method::HEAD {
                        Vec::new()
                    } else {
                        tile_bytes.to_vec()
                    }))
                    .expect("valid tile response")
            }
            Err(_) => Self::empty_response(StatusCode::BAD_GATEWAY),
        }
    }

    async fn handle_request(
        &self,
        req: Request<HyperBody>,
        remote_ip: IpAddr,
    ) -> Result<Response<HyperBody>, Infallible> {
        info!("{} {}", req.method(), req.uri());
        match self.forward_request(req, remote_ip).await {
            Ok(response) => Ok(response),
            Err(err) => {
                error!("Request handling error: {}", err);
                Ok(Self::text_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error",
                ))
            }
        }
    }

    pub async fn run(self, config: ProxyConfig) -> Result<(), hyper::Error> {
        let addr = config.listen_addr.parse().expect("invalid listen address");
        let proxy = Arc::new(self);
        let make_service = make_service_fn(move |connection: &AddrStream| {
            let proxy = proxy.clone();
            let remote_ip = connection.remote_addr().ip();
            async move {
                Ok::<_, Infallible>(service_fn(move |request| {
                    let proxy = proxy.clone();
                    async move { proxy.handle_request(request, remote_ip).await }
                }))
            }
        });

        info!("OSM proxy listening on http://{}", addr);
        Server::bind(&addr).serve(make_service).await
    }
}

fn is_private_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let addr_str = host.trim_start_matches('[').trim_end_matches(']');
    match addr_str.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        Ok(IpAddr::V6(v6)) => v6.is_loopback(),
        Err(_) => false,
    }
}

#[cfg(test)]
struct ProxyTestHelper;

#[cfg(test)]
impl ProxyTestHelper {
    fn encoding(headers: &HeaderMap) -> Option<&'static str> {
        OsmProxy::preferred_encoding(headers)
    }

    fn compress(
        data: Vec<u8>,
        content_type: &str,
        headers: &HeaderMap,
    ) -> (Vec<u8>, Option<&'static str>) {
        OsmProxy::maybe_compress(data, content_type, headers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::SmartCache;

    fn test_proxy() -> OsmProxy {
        test_proxy_with_trusted(Vec::new())
    }

    fn test_proxy_with_trusted(trusted_proxy_ips: Vec<IpAddr>) -> OsmProxy {
        let config = ProxyConfig::default();
        OsmProxy::new(
            Arc::new(SmartCache::new(100, Duration::from_secs(60))),
            None,
            AiRouter::from_config(&config),
            "https://www.openstreetmap.org".to_string(),
            "https://tile.openstreetmap.org".to_string(),
            PathBuf::from("../dist"),
            "test-client".to_string(),
            Some("https://map.osm.asia/callback".to_string()),
            std::env::temp_dir().join("betterid-proxy-tests"),
            trusted_proxy_ips,
            false,
            PrivacyUploader::from_config(&config),
        )
    }

    #[test]
    fn test_preferred_encoding() {
        let headers = |value: &str| {
            let mut map = HeaderMap::new();
            map.insert(http::header::ACCEPT_ENCODING, value.parse().unwrap());
            map
        };

        assert_eq!(ProxyTestHelper::encoding(&headers("gzip, deflate, br")), Some("br"));
        assert_eq!(ProxyTestHelper::encoding(&headers("gzip, deflate")), Some("gzip"));
        assert_eq!(ProxyTestHelper::encoding(&headers("identity")), None);
        assert_eq!(ProxyTestHelper::encoding(&headers("br;q=0, gzip;q=1")), Some("gzip"));
        assert_eq!(ProxyTestHelper::encoding(&headers("br;q=0")), None);
        let empty = HeaderMap::new();
        assert_eq!(ProxyTestHelper::encoding(&empty), None);
    }

    #[test]
    fn test_maybe_compress_static_asset() {
        let source = "(function(){ /* a fairly repetitive script body */ })();".repeat(400);
        let data = source.into_bytes();

        let mut headers = HeaderMap::new();
        headers.insert(http::header::ACCEPT_ENCODING, "gzip, br".parse().unwrap());
        let (compressed, encoding) =
            ProxyTestHelper::compress(data.clone(), "application/javascript; charset=utf-8", &headers);
        assert_eq!(encoding, Some("br"));
        assert!(compressed.len() < data.len() / 2);

        // a client that asks for nothing gets the raw body
        let (raw, none) = ProxyTestHelper::compress(data.clone(), "application/javascript; charset=utf-8", &HeaderMap::new());
        assert_eq!(none, None);
        assert_eq!(raw.len(), data.len());

        // tiny or binary bodies are passed through
        let small = b"a".to_vec();
        let (tiny, tiny_encoding) = ProxyTestHelper::compress(small, "application/javascript", &headers);
        assert!(tiny_encoding.is_none());
        assert_eq!(tiny.len(), 1);
        let (png, png_encoding) = ProxyTestHelper::compress(data, "image/png", &headers);
        assert!(png_encoding.is_none());
    }

    #[test]
    fn test_should_cache() {
        let proxy = test_proxy();
        assert!(proxy.should_cache(&Method::GET, "/tile/1/2/3.png"));
        assert!(!proxy.should_cache(&Method::GET, "/api/capabilities.json"));
        assert!(!proxy.should_cache(&Method::GET, "/api/0.6/node/1"));
        assert!(!proxy.should_cache(&Method::GET, "/api/0.6/map"));
        assert!(!proxy.should_cache(&Method::POST, "/api/0.6/node"));
        assert!(!proxy.should_cache(&Method::GET, "/login"));
    }

    #[test]
    fn test_private_response_is_not_cached() {
        let proxy = test_proxy();
        let response = Response::builder()
            .status(StatusCode::OK)
            .header("cache-control", "private, max-age=0, must-revalidate")
            .body(HyperBody::empty())
            .unwrap();

        assert!(!proxy.should_cache_response(&response));
    }

    #[test]
    fn test_session_response_is_not_cached() {
        let proxy = test_proxy();
        let response = Response::builder()
            .status(StatusCode::OK)
            .header("set-cookie", "_osm_session=private")
            .body(HyperBody::empty())
            .unwrap();

        assert!(!proxy.should_cache_response(&response));
    }

    #[test]
    fn test_blocked_tile_response_is_not_cached() {
        let proxy = test_proxy();
        let response = Response::builder()
            .status(StatusCode::OK)
            .header("x-blocked", "1")
            .body(HyperBody::empty())
            .unwrap();

        assert!(!proxy.should_cache_response(&response));
    }

    #[test]
    fn test_osm_data_disables_client_cache() {
        let mut response = Response::new(HyperBody::empty());
        OsmProxy::apply_client_cache_policy("/api/0.6/way/1", &mut response);

        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "no-store, no-cache, must-revalidate"
        );
        assert_eq!(response.headers().get("pragma").unwrap(), "no-cache");
        assert_eq!(response.headers().get("expires").unwrap(), "0");
    }

    #[test]
    fn test_tiles_keep_upstream_cache_control() {
        let mut response = Response::new(HyperBody::empty());
        response.headers_mut().insert(
            "cache-control",
            HeaderValue::from_static("public, max-age=86400"),
        );
        OsmProxy::apply_client_cache_policy("/tile/1/2/3.png", &mut response);

        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "public, max-age=86400"
        );
    }

    #[test]
    fn test_tiles_get_seven_day_cache_fallback() {
        let mut response = Response::new(HyperBody::empty());
        OsmProxy::apply_client_cache_policy("/tile/1/2/3.png", &mut response);

        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            TILE_FALLBACK_CACHE_CONTROL
        );
    }

    #[test]
    fn test_tile_cache_ttl_uses_cache_control() {
        let headers = Request::builder()
            .header("cache-control", "public, max-age=86400, s-maxage=172800")
            .body(HyperBody::empty())
            .unwrap()
            .headers()
            .clone();

        assert_eq!(
            OsmProxy::tile_cache_ttl(&headers),
            Duration::from_secs(172800)
        );
    }

    #[test]
    fn test_tile_cache_ttl_falls_back_to_seven_days() {
        assert_eq!(
            OsmProxy::tile_cache_ttl(&HeaderMap::new()),
            TILE_FALLBACK_CACHE_TTL
        );
    }

    #[test]
    fn test_tile_referer_uses_request_or_fallback() {
        let headers = Request::builder()
            .header("referer", "https://map.osm.asia/id/")
            .body(HyperBody::empty())
            .unwrap()
            .headers()
            .clone();

        assert_eq!(OsmProxy::tile_referer(&headers), "https://map.osm.asia/id/");
        assert_eq!(
            OsmProxy::tile_referer(&HeaderMap::new()),
            TILE_FALLBACK_REFERER
        );
    }

    #[test]
    fn test_query_service_disables_client_cache() {
        let mut response = Response::new(HyperBody::empty());
        OsmProxy::apply_client_cache_policy("/query-features", &mut response);

        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "no-store, no-cache, must-revalidate"
        );
    }

    #[tokio::test]
    async fn test_query_service_route() {
        let proxy = test_proxy();
        let url = proxy
            .build_upstream_url("/query-features", Some("lat=1&lon=2"))
            .await
            .unwrap();

        assert_eq!(
            url.as_str(),
            "https://query.openstreetmap.org/query-features?lat=1&lon=2"
        );
    }

    #[test]
    fn test_csp_allows_osm_asia_logo_without_weakening_scripts() {
        let policy = "default-src 'self'; img-src 'self' data:; script-src 'self' 'nonce-test'; style-src 'self' 'nonce-test'";
        let rewritten = OsmProxy::rewrite_content_security_policy(policy);

        assert!(rewritten.contains("img-src 'self' data: https://osm.asia"));
        assert!(rewritten.contains("script-src 'self' 'nonce-test'"));
        assert!(rewritten.contains("style-src 'self' 'nonce-test'"));
        assert_eq!(
            OsmProxy::rewrite_content_security_policy(&rewritten),
            rewritten
        );
    }

    #[test]
    fn test_query_service_url_is_rewritten() {
        let proxy = test_proxy();
        let source = br#"const url = "https://query.openstreetmap.org/query-features";"#;
        let rewritten = proxy.rewrite_urls(
            source,
            "application/javascript",
            "/assets/application.js",
            None,
        );

        assert!(String::from_utf8_lossy(&rewritten).contains("\"/query-features\""));
    }

    #[test]
    fn test_standard_osm_tile_url_is_rewritten() {
        let proxy = test_proxy();
        let source = br#"{"template":"https://tile.openstreetmap.org/{zoom}/{x}/{y}.png"}"#;
        let rewritten = proxy.rewrite_urls(
            source,
            "application/json; charset=utf-8",
            "/id/dist/data/imagery.min.json",
            None,
        );

        assert!(String::from_utf8_lossy(&rewritten).contains("\"/tile/{zoom}/{x}/{y}.png\""));
    }

    #[test]
    fn test_osm_tile_service_hosts_are_identified() {
        for url in [
            "https://tile.openstreetmap.org/1/2/3.png",
            "https://gps.tile.openstreetmap.org/lines/1/2/3.png",
            "https://a.gps-tile.openstreetmap.org/lines/1/2/3.png",
        ] {
            assert!(OsmProxy::is_osm_tile_service_url(&Url::parse(url).unwrap()));
        }
        assert!(!OsmProxy::is_osm_tile_service_url(
            &Url::parse("https://tiles.example.com/1/2/3.png").unwrap()
        ));
    }

    #[test]
    fn test_query_service_only_receives_totp_cookie() {
        let cookie = "_osm_session=private; _osm_totp_token=123456; preferences=private";

        assert_eq!(
            OsmProxy::query_service_cookie(cookie).as_deref(),
            Some("_osm_totp_token=123456")
        );
        assert_eq!(OsmProxy::query_service_cookie("_osm_session=private"), None);
    }

    #[test]
    fn test_rewritten_javascript_gets_browser_cache_buster() {
        let proxy = test_proxy();
        let source = br#"<script src="/assets/application-digest.js"></script>"#;
        let rewritten = proxy.rewrite_urls(source, "text/html", "/query", None);

        assert!(
            String::from_utf8_lossy(&rewritten)
                .contains("src=\"/assets/application-digest.js?betterid-proxy=1\"")
        );
    }

    #[test]
    fn test_content_types() {
        assert_eq!(
            OsmProxy::content_type(Path::new("iD.js")),
            "application/javascript; charset=utf-8"
        );
        assert_eq!(
            OsmProxy::content_type(Path::new("iD.css")),
            "text/css; charset=utf-8"
        );
    }

    #[test]
    fn test_translation_language_validation_accepts_bcp47() {
        assert!(OsmProxy::valid_bcp47("zh-Hant"));
        assert!(OsmProxy::valid_bcp47("sr-Latn-RS"));
        assert!(!OsmProxy::valid_bcp47("zh_Hant"));
        assert!(!OsmProxy::valid_bcp47("en--US"));
        assert!(!OsmProxy::valid_bcp47(""));
    }

    #[tokio::test]
    async fn test_ai_status_does_not_expose_credentials() {
        let response = test_proxy()
            .handle_ai_request(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/osm-ai/status")
                    .body(HyperBody::empty())
                    .expect("status request"),
                "127.0.0.1".parse().expect("loopback address"),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = hyper::body::to_bytes(response.into_body())
            .await
            .expect("status body");
        let status: Value = serde_json::from_slice(&body).expect("status JSON");
        assert_eq!(status["search"], false);
        assert_eq!(status["visual"], false);
        assert!(status.get("api_key").is_none());
    }

    #[test]
    fn forwarded_headers_are_ignored_from_untrusted_peers() {
        let proxy = test_proxy();
        let headers = Request::builder()
            .header("forwarded", "for=203.0.113.8")
            .header("x-forwarded-for", "203.0.113.9")
            .body(HyperBody::empty())
            .unwrap()
            .headers()
            .clone();
        let peer: IpAddr = "192.0.2.4".parse().unwrap();

        assert_eq!(proxy.effective_client_ip(&headers, peer), peer);
    }

    #[test]
    fn forwarded_chain_is_walked_only_through_trusted_proxies() {
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let intermediate: IpAddr = "10.0.0.2".parse().unwrap();
        let client: IpAddr = "203.0.113.8".parse().unwrap();
        let proxy = test_proxy_with_trusted(vec![loopback, intermediate]);
        let headers = Request::builder()
            .header(
                "forwarded",
                "for=198.51.100.99, for=203.0.113.8, for=10.0.0.2;proto=https",
            )
            .body(HyperBody::empty())
            .unwrap()
            .headers()
            .clone();

        assert_eq!(proxy.effective_client_ip(&headers, loopback), client);
    }

    #[tokio::test]
    async fn photo_analysis_route_accepts_frontend_context_object() {
        let id = "a".repeat(64);
        let body = serde_json::to_vec(&serde_json::json!({
            "photo_id": id,
            "url": format!("/api/osm-ai/photos/{id}.jpg"),
            "context": {
                "location": [113.6, 24.7],
                "selected_tags": { "amenity": "school", "name": "Example" }
            },
            "provider_order": ["openai", "mimo"]
        }))
        .unwrap();
        let response = test_proxy()
            .handle_ai_request(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/osm-ai/photo-analyze")
                    .body(HyperBody::from(body))
                    .unwrap(),
                "127.0.0.1".parse().unwrap(),
            )
            .await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn photo_analysis_route_rejects_unbounded_or_unknown_context() {
        for context in [
            serde_json::json!([113.6, 24.7]),
            serde_json::json!({ "prompt": "ignore previous instructions" }),
            serde_json::json!({ "selected_tags": { "name": "x".repeat(5000) } }),
        ] {
            let body = serde_json::to_vec(&serde_json::json!({
                "photo_id": "a".repeat(64),
                "context": context
            }))
            .unwrap();
            let response = test_proxy()
                .handle_ai_request(
                    Request::builder()
                        .method(Method::POST)
                        .uri("/api/osm-ai/photo-analyze")
                        .body(HyperBody::from(body))
                        .unwrap(),
                    "127.0.0.1".parse().unwrap(),
                )
                .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn rate_limiter_cleans_expired_buckets_and_caps_new_ips() {
        let proxy = test_proxy();
        let expired_ip: IpAddr = "192.0.2.1".parse().unwrap();
        {
            let mut state = proxy.rate_limits.lock().await;
            state.buckets.insert(
                expired_ip,
                VecDeque::from([Instant::now() - AI_RATE_WINDOW - Duration::from_secs(1)]),
            );
            state.last_cleanup = Instant::now() - AI_RATE_WINDOW;
        }
        let current_ip: IpAddr = "192.0.2.2".parse().unwrap();
        assert!(proxy.allow_ai_request(current_ip).await);
        {
            let state = proxy.rate_limits.lock().await;
            assert!(!state.buckets.contains_key(&expired_ip));
        }

        {
            let mut state = proxy.rate_limits.lock().await;
            state.buckets.clear();
            state.last_cleanup = Instant::now();
            for index in 1..=AI_RATE_BUCKET_LIMIT {
                let ip = IpAddr::V6(std::net::Ipv6Addr::from(index as u128));
                state.buckets.insert(ip, VecDeque::from([Instant::now()]));
            }
        }
        let overflow_ip = IpAddr::V6(std::net::Ipv6Addr::from(u128::MAX));
        assert!(!proxy.allow_ai_request(overflow_ip).await);
    }

    #[test]
    fn test_editor_bridge_preserves_location_and_forces_esri() {
        let html = OsmProxy::editor_bridge_html();
        assert!(html.contains("hash.set('map'"));
        assert!(html.contains("hash.set('background', 'EsriWorldImagery')"));
        assert!(html.contains("window.location.replace('/id/#'"));
    }

    #[test]
    fn test_login_page_adds_official_oauth_choice() {
        let proxy = test_proxy();
        let source = br#"<html lang="zh-CN"><body><form id="login_form" action="/login"></form></body></html>"#;
        let query = concat!(
            "cookie_test=true&referer=",
            "%2Foauth2%2Fauthorize%3Fclient_id%3Dtest-client",
            "%26redirect_uri%3Dhttp%253A%252F%252F127.0.0.1%253A9178%252Fid%252Fland.html"
        );
        let html = String::from_utf8(proxy.rewrite_urls(
            source,
            "text/html; charset=utf-8",
            "/login",
            Some(query),
        ))
        .expect("valid UTF-8");

        assert!(html.contains("id=\"betterid-osm-auth-choice\""));
        assert!(html.contains("使用 OpenStreetMap 官网授权登录"));
        assert!(html.contains("或使用账号密码登录"));
        assert!(html.contains(
            "https://www.openstreetmap.org/oauth2/authorize?client_id=test-client&amp;redirect_uri="
        ));
        assert!(html.find("betterid-osm-auth-choice") < html.find("login_form"));
    }

    #[test]
    fn test_login_page_rejects_unrelated_referer() {
        let proxy = test_proxy();
        let source = br#"<html><body><form id="login_form"></form></body></html>"#;
        let html = proxy.rewrite_urls(source, "text/html", "/login", Some("referer=%2F"));
        assert!(!String::from_utf8_lossy(&html).contains("betterid-osm-auth-choice"));
    }

    #[test]
    fn test_root_page_adds_modern_login_modal() {
        let proxy = test_proxy();
        let source = br#"<html lang="zh-CN"><head></head><body><div class="login-menu"><a href="/login?referer=%2F">Login</a></div></body></html>"#;
        let html = String::from_utf8(proxy.rewrite_urls(source, "text/html", "/", None))
            .expect("valid UTF-8");

        assert!(html.contains("href=\"/betterid/login-modal.css\""));
        assert!(html.contains("src=\"/betterid/login-modal.js\""));
        assert!(html.contains("id=\"betterid-login-modal\""));
        assert!(html.contains("选择登录方式"));
        assert!(html.contains("登录 map.osm.asia"));
        assert!(html.contains("使用 OSM 官网授权登录"));
        assert!(html.contains("BetteriD 编辑器"));
        assert!(html.contains("href=\"/id/oauth/start\""));
    }

    #[test]
    fn test_root_login_modal_script_shows_oauth_status() {
        assert!(LOGIN_MODAL_JS.contains("oauth2_access_token"));
        assert!(LOGIN_MODAL_JS.contains("/api/0.6/user/details.json"));
        assert!(LOGIN_MODAL_JS.contains("Authorization: `Bearer ${token}`"));
        assert!(LOGIN_MODAL_JS.contains("betterid-login-status"));
        assert!(LOGIN_MODAL_JS.contains("clearOauthToken();"));
    }

    #[test]
    fn test_pages_use_osm_asia_branding() {
        let proxy = test_proxy();
        let source = br#"<html><body><a href="/#map=17/24/113" class="icon-link gap-1 me-auto text-body-emphasis text-decoration-none geolink"><img alt="OpenStreetMap logo" src="/assets/osm_logo-digest.svg" width="30" height="30">OpenStreetMap</a></body></html>"#;
        let html = String::from_utf8(proxy.rewrite_urls(source, "text/html", "/", None))
            .expect("valid UTF-8");

        assert!(html.contains("src=\"https://osm.asia/logo.jpg\""));
        assert!(html.contains("alt=\"OSM.asia logo\""));
        assert!(html.contains("OSM.asia"));
        assert!(!html.contains("osm_logo-digest.svg"));
        assert!(!html.contains(">OpenStreetMap</a>"));

        let login_source = br#"<html><body><a href="/" class="navbar-brand"><img src="/assets/osm_logo.svg" alt="OpenStreetMap logo">OpenStreetMap</a><p>OpenStreetMap account</p></body></html>"#;
        let login_html =
            String::from_utf8(proxy.rewrite_urls(login_source, "text/html", "/login", None))
                .expect("valid UTF-8");
        assert!(login_html.contains("src=\"https://osm.asia/logo.jpg\""));
        assert!(login_html.contains("<p>OpenStreetMap account</p>"));
    }

    #[test]
    fn test_root_page_adds_mirror_notice() {
        let source = "<html><head></head><body>Map</body></html>";
        let html = OsmProxy::inject_mirror_notice(source, "/");

        assert!(html.contains("id=\"betterid-mirror-notice\""));
        assert!(html.contains("map.osm.asia 是 OpenStreetMap 的第三方镜像服务"));
        assert!(html.contains("href=\"https://www.openstreetmap.org/\""));
        assert!(html.contains("/betterid/mirror-notice.css"));
        assert!(html.contains("/betterid/mirror-notice.js"));
        assert_eq!(OsmProxy::inject_mirror_notice(&html, "/"), html);
        assert_eq!(OsmProxy::inject_mirror_notice(source, "/login"), source);
    }

    #[test]
    fn test_oauth_start_uses_pkce_without_client_secret() {
        let html = test_proxy().oauth_start_html();
        assert!(html.contains("test-client"));
        assert!(html.contains("code_challenge_method"));
        assert!(html.contains("new URL('/oauth2/authorize', officialOrigin)"));
        assert!(html.contains("authorize.searchParams.set('response_type', 'code')"));
        assert!(html.contains("betterid.oauth.root"));
        assert!(html.contains("https://map.osm.asia/callback"));
        assert!(!html.contains("client_secret"));
    }

    #[test]
    fn test_editor_uses_official_site_for_oauth_and_proxy_for_api() {
        let config = test_proxy().id_runtime_config(123);

        assert!(config.contains("url:\"https://www.openstreetmap.org\""));
        assert!(config.contains("apiUrl:window.location.origin"));
        assert!(!config.contains("url:window.location.origin"));
    }
}
