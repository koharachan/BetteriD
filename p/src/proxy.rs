use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::BytesMut;
use http::{HeaderValue, Method, Request, Response, StatusCode};
use hyper::body::HttpBody;
use hyper::server::conn::AddrStream;
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body as HyperBody, Server};
use log::{debug, error, info};
use reqwest::Client as ReqwestClient;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;
use url::{Url, form_urlencoded};

use crate::ai::AiGenerator;
use crate::cache::{CacheEntry, CacheHandle};
use crate::config::ProxyConfig;
use crate::translate::{BatchTranslation, FreeTranslator, Translator};

const AI_BODY_LIMIT: usize = 64 * 1024;
const AI_RATE_LIMIT: usize = 30;
const AI_RATE_WINDOW: Duration = Duration::from_secs(60);
const LOGIN_MODAL_CSS: &str = include_str!("../web/login-modal.css");
const LOGIN_MODAL_JS: &str = include_str!("../web/login-modal.js");
const LOGIN_MODAL_TEMPLATE: &str = include_str!("../web/login-modal.html");
const OAUTH_START_TEMPLATE: &str = include_str!("../web/oauth-start.html");

#[derive(Clone)]
pub struct OsmProxy {
    client: ReqwestClient,
    cache: CacheHandle,
    translator: Option<Translator>,
    free_translator: FreeTranslator,
    ai_generator: Option<AiGenerator>,
    upstream_url: String,
    tile_upstream_url: String,
    static_dir: PathBuf,
    oauth_client_id: String,
    oauth_redirect_uri: Option<String>,
    rate_limits: Arc<Mutex<HashMap<IpAddr, VecDeque<Instant>>>>,
}

#[derive(Deserialize)]
struct TranslateApiRequest {
    text: String,
    target_langs: Vec<String>,
}

#[derive(Serialize)]
struct TranslationItem {
    lang: String,
    text: String,
}

#[derive(Deserialize)]
struct SummaryApiRequest {
    summary: Value,
}

impl OsmProxy {
    pub fn new(
        cache: CacheHandle,
        translator: Option<Translator>,
        ai_generator: Option<AiGenerator>,
        upstream_url: String,
        tile_upstream_url: String,
        static_dir: PathBuf,
        oauth_client_id: String,
        oauth_redirect_uri: Option<String>,
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
            ai_generator,
            upstream_url,
            tile_upstream_url,
            static_dir,
            oauth_client_id,
            oauth_redirect_uri,
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
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
            return Ok(self.serve_static_file(relative, &method).await);
        }
        if matches!(path.as_str(), "/edit" | "/editor" | "/iD") {
            return Ok(Self::serve_editor_bridge(&method));
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
        if self.should_cache_response(&response) {
            let ttl = self.cache.get_ttl(&path);
            let headers = response.headers().clone();
            let status = response.status();
            let body = hyper::body::to_bytes(response.body_mut()).await?;
            let entry = CacheEntry {
                body: body.clone(),
                headers,
                status,
                created_at: Instant::now(),
                ttl,
            };
            self.cache.set(&cache_key, entry.clone()).await;
            return Ok(self.build_cache_response(entry));
        }

        Ok(response)
    }

    async fn handle_ai_request(
        &self,
        req: Request<HyperBody>,
        remote_ip: IpAddr,
    ) -> Response<HyperBody> {
        if !Self::same_origin(&req) {
            return Self::json_response(
                StatusCode::FORBIDDEN,
                serde_json::json!({
                    "error": "Cross-origin requests are not allowed"
                }),
            );
        }

        let path = req.uri().path().to_string();
        if path == "/api/osm-ai/status" && req.method() == Method::GET {
            return Self::json_response(
                StatusCode::OK,
                serde_json::json!({
                    "ai": self.ai_generator.is_some(),
                    "translate": true
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
        if !self.allow_ai_request(remote_ip).await {
            return Self::json_response(
                StatusCode::TOO_MANY_REQUESTS,
                serde_json::json!({
                    "error": "Rate limit exceeded"
                }),
            );
        }

        let body = match Self::read_body_limited(req.into_body(), AI_BODY_LIMIT).await {
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
            _ => Self::json_response(
                StatusCode::NOT_FOUND,
                serde_json::json!({
                    "error": "Not found"
                }),
            ),
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
        if text.is_empty() || text.chars().count() > 500 {
            return Self::json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "error": "Invalid translation text"
                }),
            );
        }
        let mut result = None;
        if let Some(translator) = &self.translator {
            result = translator.translate_three(text).await;
        }
        if result.is_none() {
            result = self.free_translator.translate_three(text).await;
        }
        if result.is_none() {
            if let Some(ai) = &self.ai_generator {
                match ai.translate_three(text).await {
                    Ok(ai_result) => {
                        result = Some(BatchTranslation {
                            zh_cn: ai_result.zh_cn,
                            zh_tw: ai_result.zh_tw,
                            en: ai_result.en,
                        });
                    }
                    Err(err) => error!("DeepSeek translation failed: {}", err),
                }
            }
        }

        let Some(result) = result else {
            return Self::json_response(
                StatusCode::BAD_GATEWAY,
                serde_json::json!({
                    "error": "Translation service request failed"
                }),
            );
        };

        let mut translations = Vec::new();
        for lang in request.target_langs.into_iter().take(3) {
            let text = match lang.as_str() {
                "zh" => Some(result.zh_cn.clone()),
                "zh-Hant" => Some(result.zh_tw.clone()),
                "en" => Some(result.en.clone()),
                _ => None,
            };
            if let Some(text) = text.filter(|value| !value.is_empty()) {
                if !translations
                    .iter()
                    .any(|item: &TranslationItem| item.lang == lang)
                {
                    translations.push(TranslationItem { lang, text });
                }
            }
        }

        Self::json_response(
            StatusCode::OK,
            serde_json::json!({ "translations": translations }),
        )
    }

    async fn handle_summarize(&self, body: &[u8]) -> Response<HyperBody> {
        let Some(ai) = &self.ai_generator else {
            return Self::json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({
                    "error": "AI service is not configured"
                }),
            );
        };
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

        match ai.summarize_changes(&request.summary).await {
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

    async fn allow_ai_request(&self, remote_ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut limits = self.rate_limits.lock().await;
        let requests = limits.entry(remote_ip).or_default();
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
        let client_id =
            serde_json::to_string(&self.oauth_client_id).unwrap_or_else(|_| "\"\"".to_string());
        let redirect_uri =
            serde_json::to_string(&self.oauth_redirect_uri).unwrap_or_else(|_| "null".to_string());
        let runtime_config = format!(
            "<script>window.OSM_PROXY_CONFIG={{assetVersion:{asset_version},osmApiConnection:{{url:window.location.origin,apiUrl:window.location.origin,client_id:{client_id},redirect_uri:{redirect_uri}}}}};</script>"
        );
        html = html.replace("</head>", &format!("{runtime_config}</head>"));
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

    async fn serve_static_file(&self, relative: &str, method: &Method) -> Response<HyperBody> {
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
        Self::file_response(
            StatusCode::OK,
            content_type,
            if method == Method::HEAD {
                Vec::new()
            } else {
                data
            },
            "public, max-age=3600",
        )
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
        Response::builder()
            .status(status)
            .header("content-type", content_type)
            .header("cache-control", cache_control)
            .header("content-length", data.len())
            .header("x-content-type-options", "nosniff")
            .body(HyperBody::from(data))
            .expect("valid file response")
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
            response.headers_mut().insert(
                "cache-control",
                HeaderValue::from_static("public, max-age=600"),
            );
            response.headers_mut().remove("pragma");
            response.headers_mut().remove("expires");
        }
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
        let mut request_builder = self
            .client
            .request(reqwest_method, upstream_url.as_str())
            .body(body.to_vec());

        for (key, value) in &headers {
            let key_lower = key.as_str().to_ascii_lowercase();
            if matches!(
                key_lower.as_str(),
                "host" | "content-length" | "origin" | "referer"
            ) || (!forwards_private_headers
                && matches!(key_lower.as_str(), "cookie" | "authorization"))
            {
                continue;
            }
            request_builder = request_builder.header(key.as_str(), value.as_bytes());
        }
        if headers.contains_key("origin") {
            request_builder = request_builder.header("origin", &self.upstream_url);
        }
        if headers.contains_key("referer") {
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

    fn clean_cookie_domain(cookie: &str) -> String {
        cookie
            .split(';')
            .filter(|part| !part.trim().to_ascii_lowercase().starts_with("domain="))
            .collect::<Vec<_>>()
            .join(";")
    }

    fn rewrite_location(&self, location: &str) -> String {
        location
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
        let rewritten = text
            .replace("https://tile.openstreetmap.org/", "/tile/")
            .replace("http://tile.openstreetmap.org/", "/tile/")
            .replace("//tile.openstreetmap.org/", "/tile/")
            .replace("https://gps.tile.openstreetmap.org/lines/", "/tile/lines/")
            .replace(
                "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/",
                "/tile/arcgis/",
            )
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
        self.inject_root_login_modal(&rewritten, path).into_bytes()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::SmartCache;

    fn test_proxy() -> OsmProxy {
        OsmProxy::new(
            Arc::new(SmartCache::new(100, Duration::from_secs(60))),
            None,
            None,
            "https://www.openstreetmap.org".to_string(),
            "https://tile.openstreetmap.org".to_string(),
            PathBuf::from("../dist"),
            "test-client".to_string(),
            Some("https://map.osm.asia/callback".to_string()),
        )
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
    fn test_tiles_expire_after_ten_minutes() {
        let mut response = Response::new(HyperBody::empty());
        OsmProxy::apply_client_cache_policy("/tile/1/2/3.png", &mut response);

        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "public, max-age=600"
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
    fn test_oauth_start_uses_pkce_without_client_secret() {
        let html = test_proxy().oauth_start_html();
        assert!(html.contains("test-client"));
        assert!(html.contains("code_challenge_method"));
        assert!(html.contains("new URL('/logout', officialOrigin)"));
        assert!(html.contains("'/login?referer='"));
        assert!(html.contains("betterid.oauth.root"));
        assert!(html.contains("https://map.osm.asia/callback"));
        assert!(!html.contains("client_secret"));
    }
}
