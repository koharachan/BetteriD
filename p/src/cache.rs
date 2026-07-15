use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use http::{HeaderMap, StatusCode};
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub body: Bytes,
    pub headers: HeaderMap,
    pub status: StatusCode,
    pub created_at: Instant,
    pub ttl: Duration,
}

impl CacheEntry {
    pub fn is_expired(&self) -> bool {
        Instant::now().duration_since(self.created_at) >= self.ttl
    }
}

#[derive(Debug)]
pub struct SmartCache {
    cache: RwLock<HashMap<String, CacheEntry>>,
    max_size: usize,
    default_ttl: Duration,
    ttl_overrides: HashMap<String, Duration>,
    hit_count: RwLock<u64>,
    miss_count: RwLock<u64>,
    cache_dir: Option<PathBuf>,
}

impl SmartCache {
    #[allow(dead_code)]
    pub fn new(max_size: usize, default_ttl: Duration) -> Self {
        Self::with_cache_dir(max_size, default_ttl, None)
    }

    pub fn with_cache_dir(
        max_size: usize,
        default_ttl: Duration,
        cache_dir: Option<PathBuf>,
    ) -> Self {
        let mut ttl_overrides = HashMap::new();
        ttl_overrides.insert("/tile".to_string(), Duration::from_mins(10));
        ttl_overrides.insert("/api".to_string(), Duration::from_mins(5));
        ttl_overrides.insert("/geocoder".to_string(), Duration::from_mins(15));
        ttl_overrides.insert("/planet".to_string(), Duration::from_secs(7 * 24 * 3600));
        ttl_overrides.insert("/style".to_string(), Duration::from_hours(6));
        ttl_overrides.insert("/iD".to_string(), Duration::from_hours(1));

        // Create cache dir if specified
        if let Some(ref dir) = cache_dir {
            let _ = std::fs::create_dir_all(dir);
        }

        SmartCache {
            cache: RwLock::new(HashMap::new()),
            max_size,
            default_ttl,
            ttl_overrides,
            hit_count: RwLock::new(0),
            miss_count: RwLock::new(0),
            cache_dir,
        }
    }

    fn cache_file_path(&self, key: &str) -> Option<PathBuf> {
        self.cache_dir.as_ref().map(|dir| {
            let encoded = URL_SAFE_NO_PAD.encode(key.as_bytes());
            dir.join(format!("{}.cache", encoded))
        })
    }

    pub fn get_ttl(&self, path: &str) -> Duration {
        for (prefix, ttl) in &self.ttl_overrides {
            if path.starts_with(prefix) {
                return *ttl;
            }
        }
        self.default_ttl
    }

    pub async fn get(&self, key: &str) -> Option<CacheEntry> {
        // First try with a read lock for the common case (cache hit, not expired)
        {
            let cache = self.cache.read().await;
            if let Some(entry) = cache.get(key) {
                if !entry.is_expired() {
                    *self.hit_count.write().await += 1;
                    return Some(entry.clone());
                }
            }
        }

        // Need write lock to remove expired entry or record miss
        let mut cache = self.cache.write().await;
        if let Some(entry) = cache.get(key) {
            if entry.is_expired() {
                cache.remove(key);
            } else {
                *self.hit_count.write().await += 1;
                return Some(entry.clone());
            }
        }
        *self.miss_count.write().await += 1;
        None
    }

    pub async fn set(&self, key: &str, entry: CacheEntry) {
        let mut cache = self.cache.write().await;

        if cache.len() >= self.max_size {
            self.evict_oldest(&mut cache);
        }

        // Write to disk if cache_dir is configured
        if let Some(ref file_path) = self.cache_file_path(key) {
            let _ = self.write_cache_file(file_path, &entry).await;
        }

        cache.insert(key.to_string(), entry);
    }

    async fn write_cache_file(
        &self,
        path: &PathBuf,
        entry: &CacheEntry,
    ) -> Result<(), std::io::Error> {
        // File format:
        // [4 bytes: magic "CACH"]
        // [8 bytes: ttl_secs as u64 LE]
        // [8 bytes: created_at unix timestamp as u64 LE]
        // [body bytes]
        let mut buf = Vec::with_capacity(20 + entry.body.len());
        buf.extend_from_slice(b"CACH");
        buf.extend_from_slice(&entry.ttl.as_secs().to_le_bytes());

        let created_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        buf.extend_from_slice(&created_secs.to_le_bytes());
        buf.extend_from_slice(&entry.body);

        let mut file = tokio::fs::File::create(path).await?;
        file.write_all(&buf).await?;
        file.flush().await?;
        Ok(())
    }

    fn evict_oldest(&self, cache: &mut HashMap<String, CacheEntry>) {
        let oldest_key = cache
            .iter()
            .min_by_key(|(_, entry)| entry.created_at)
            .map(|(key, _)| key.clone());

        if let Some(key) = oldest_key {
            cache.remove(&key);
        }
    }

    pub async fn get_stats(&self) -> (u64, u64, usize) {
        (
            *self.hit_count.read().await,
            *self.miss_count.read().await,
            self.cache.read().await.len(),
        )
    }
}

pub type CacheHandle = Arc<SmartCache>;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cache_basic() {
        let cache = SmartCache::new(100, Duration::from_secs(60));

        let entry = CacheEntry {
            body: Bytes::from("test"),
            headers: HeaderMap::new(),
            status: StatusCode::OK,
            created_at: Instant::now(),
            ttl: Duration::from_secs(60),
        };

        cache.set("/test", entry).await;

        let retrieved = cache.get("/test").await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().body, Bytes::from("test"));
    }

    #[tokio::test]
    async fn test_cache_expiration() {
        let cache = SmartCache::new(100, Duration::from_millis(10));

        let entry = CacheEntry {
            body: Bytes::from("test"),
            headers: HeaderMap::new(),
            status: StatusCode::OK,
            created_at: Instant::now(),
            ttl: Duration::from_millis(10),
        };

        cache.set("/test", entry).await;

        tokio::time::sleep(Duration::from_millis(20)).await;

        let retrieved = cache.get("/test").await;
        assert!(retrieved.is_none());
    }

    #[tokio::test]
    async fn test_ttl_overrides() {
        let cache = SmartCache::new(100, Duration::from_secs(60));

        assert_eq!(cache.get_ttl("/tile/1/2/3.png"), Duration::from_mins(10));
        assert_eq!(cache.get_ttl("/api/0.6/node/1"), Duration::from_mins(5));
        assert_eq!(cache.get_ttl("/other/path"), Duration::from_secs(60));
    }
}
