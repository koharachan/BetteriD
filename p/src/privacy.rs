//! Privacy ("anonymous") upload support.
//!
//! BetteriD can push a pending changeset through this service using a dedicated
//! OpenStreetMap account, so a mapper can contribute without exposing their own
//! OSM identity. Credentials live in the server environment only; the browser
//! sends the osmChange document and receives back the changeset id.

use std::sync::Arc;
use std::time::Duration;

use log::{info, warn};
use reqwest::Client as ReqwestClient;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::config::ProxyConfig;

const API_TIMEOUT: Duration = Duration::from_secs(120);
const USER_AGENT: &str =
    "BetteriD/0.9.9-rc-1 (+https://map.osm.asia; contact=https://github.com/koharachan/BetteriD/issues)";
const CHANGESET_CREATED_BY: &str = "BetteriD privacy upload";

#[derive(Debug)]
pub enum PrivacyError {
    NotConfigured,
    InvalidRequest(String),
    Http(String),
}

impl PrivacyError {
    pub fn message(&self) -> String {
        match self {
            PrivacyError::NotConfigured => {
                "Privacy upload is not configured on this server".to_string()
            }
            PrivacyError::InvalidRequest(message) | PrivacyError::Http(message) => message.clone(),
        }
    }
}

#[derive(Debug)]
pub struct PrivacyUploadResult {
    pub changeset: u64,
    pub url: String,
    pub created: usize,
    pub modified: usize,
    pub deleted: usize,
}

#[derive(Clone)]
pub struct PrivacyUploader {
    client: ReqwestClient,
    client_id: String,
    access_token: Arc<Mutex<Option<String>>>,
    refresh_token: Option<String>,
    token_url: String,
    api_url: String,
    configured: bool,
}

impl PrivacyUploader {
    pub fn from_config(config: &ProxyConfig) -> Self {
        let client = ReqwestClient::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(API_TIMEOUT)
            .build()
            .expect("failed to create privacy upload client");

        let configured = config.privacy_configured();
        if configured {
            info!("Privacy upload credential configured (server-side OSM account)");
        }

        Self {
            client,
            client_id: config.privacy_client_id().to_string(),
            access_token: Arc::new(Mutex::new(config.privacy_access_token.clone())),
            refresh_token: config.privacy_refresh_token.clone(),
            token_url: config.privacy_token_url.clone(),
            api_url: config.privacy_api_url.trim_end_matches('/').to_string(),
            configured,
        }
    }

    pub fn configured(&self) -> bool {
        self.configured
    }

    /// Upload `osm_change` (an `<osmChange>` document) as the privacy account.
    pub async fn upload(
        &self,
        comment: &str,
        extra_tags: &[(String, String)],
        osm_change: &str,
    ) -> Result<PrivacyUploadResult, PrivacyError> {
        if !self.configured {
            return Err(PrivacyError::NotConfigured);
        }

        let diff = osm_change.trim_start_matches('\u{feff}').trim();
        if !diff.starts_with("<osmChange") {
            return Err(PrivacyError::InvalidRequest(
                "Body must contain an osmChange document".to_string(),
            ));
        }

        let changeset_xml = build_changeset_xml(comment, extra_tags);
        let changeset_body = self
            .api_request(
                reqwest::Method::PUT,
                "/api/0.6/changeset/create",
                Some(changeset_xml),
            )
            .await?;
        let changeset_id: u64 = changeset_body.trim().parse().map_err(|_| {
            PrivacyError::Http(format!(
                "OSM did not return a changeset id: {}",
                truncate(&changeset_body, 200)
            ))
        })?;

        // The client sends a standalone osmChange document (as produced by the
        // "download osmChange" link), which has no changeset attribute. The
        // upload endpoint requires one on every created/modified element
        // ("Changeset id is missing for Node -1"), and the changeset only exists
        // now, so stamp it in here.
        let stamped = inject_changeset(diff, changeset_id);

        let upload_path = format!("/api/0.6/changeset/{changeset_id}/upload");
        let diff_result = match self
            .api_request(reqwest::Method::POST, &upload_path, Some(stamped))
            .await
        {
            Ok(body) => body,
            Err(err) => {
                // Never leave an empty changeset behind when the upload fails.
                let close_path = format!("/api/0.6/changeset/{changeset_id}/close");
                if let Err(close_err) = self
                    .api_request(reqwest::Method::PUT, &close_path, None)
                    .await
                {
                    warn!(
                        "Privacy upload: could not close changeset {changeset_id} after a failed upload: {}",
                        close_err.message()
                    );
                }
                return Err(err);
            }
        };

        let close_path = format!("/api/0.6/changeset/{changeset_id}/close");
        if let Err(err) = self
            .api_request(reqwest::Method::PUT, &close_path, None)
            .await
        {
            warn!(
                "Privacy upload: changeset {} uploaded but close failed: {}",
                changeset_id,
                err.message()
            );
        }

        let (created, modified, deleted) = count_diff_elements(diff);

        Ok(PrivacyUploadResult {
            changeset: changeset_id,
            url: format!("https://www.openstreetmap.org/changeset/{changeset_id}"),
            created,
            modified,
            deleted,
        })
    }

    /// Perform one authenticated API call, refreshing the token once on 401.
    async fn api_request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<String>,
    ) -> Result<String, PrivacyError> {
        let token = self.token().await?;
        let url = format!("{}{}", self.api_url, path);

        let send = |token: String, body: Option<String>| {
            let client = self.client.clone();
            let url = url.clone();
            let method = method.clone();
            async move {
                let mut request = client
                    .request(method, &url)
                    .header(reqwest::header::USER_AGENT, USER_AGENT)
                    .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
                if let Some(body) = body {
                    request = request
                        .header(reqwest::header::CONTENT_TYPE, "text/xml; charset=utf-8")
                        .body(body);
                }
                request.send().await
            }
        };

        let response = send(token.clone(), body.clone())
            .await
            .map_err(|err| PrivacyError::Http(format!("OSM request failed: {err}")))?;

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|err| PrivacyError::Http(format!("OSM response unreadable: {err}")))?;

        if status == reqwest::StatusCode::UNAUTHORIZED && self.refresh_token.is_some() {
            let fresh = self.refresh_access_token().await?;
            let retry = send(fresh, body)
                .await
                .map_err(|err| PrivacyError::Http(format!("OSM request failed: {err}")))?;
            let retry_status = retry.status();
            let retry_text = retry
                .text()
                .await
                .map_err(|err| PrivacyError::Http(format!("OSM response unreadable: {err}")))?;
            if !retry_status.is_success() {
                return Err(PrivacyError::Http(format!(
                    "OSM returned {}: {}",
                    retry_status.as_u16(),
                    truncate(&retry_text, 300)
                )));
            }
            return Ok(retry_text);
        }

        if !status.is_success() {
            return Err(PrivacyError::Http(format!(
                "OSM returned {}: {}",
                status.as_u16(),
                truncate(&text, 300)
            )));
        }

        Ok(text)
    }

    async fn token(&self) -> Result<String, PrivacyError> {
        if let Some(token) = self.access_token.lock().await.clone() {
            return Ok(token);
        }
        self.refresh_access_token().await
    }

    async fn refresh_access_token(&self) -> Result<String, PrivacyError> {
        let Some(refresh_token) = self.refresh_token.as_ref() else {
            return Err(PrivacyError::NotConfigured);
        };

        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", self.client_id.as_str()),
        ];

        let response = self
            .client
            .post(&self.token_url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .form(&form)
            .send()
            .await
            .map_err(|err| PrivacyError::Http(format!("Token refresh failed: {err}")))?;

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|err| PrivacyError::Http(format!("Token response unreadable: {err}")))?;

        if !status.is_success() {
            return Err(PrivacyError::Http(format!(
                "Token refresh rejected ({}): {}",
                status.as_u16(),
                truncate(&text, 200)
            )));
        }

        let json: Value = serde_json::from_str(&text)
            .map_err(|_| PrivacyError::Http("Token response was not JSON".to_string()))?;
        let Some(access) = json.get("access_token").and_then(Value::as_str) else {
            return Err(PrivacyError::Http(
                "Token response had no access_token".to_string(),
            ));
        };

        *self.access_token.lock().await = Some(access.to_string());
        info!("Privacy upload: refreshed the server-side OSM access token");
        Ok(access.to_string())
    }
}

/// Element name of an opening/closing tag, e.g. `node` for `<node id="-1" />`.
fn tag_name(tag: &str) -> &str {
    let trimmed = tag
        .trim_start_matches('<')
        .trim_start_matches('/')
        .trim_start();
    let end = trimmed
        .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
        .unwrap_or(trimmed.len());
    &trimmed[..end]
}


/// Add `changeset="<id>"` to every element inside `<create>` / `<modify>` /
/// `<delete>` that does not have one yet.
///
/// The document comes from the editor's own exporter, so it is well formed and
/// attribute values are already escaped; this is a targeted text transform, not
/// a general XML parser.
fn inject_changeset(xml: &str, changeset_id: u64) -> String {
    let mut out = String::with_capacity(xml.len() + 64);
    let mut rest = xml;

    while let Some(offset) = rest.find('<') {
        out.push_str(&rest[..offset]);
        rest = &rest[offset..];

        let Some(end) = rest.find('>') else {
            out.push_str(rest);
            return out;
        };
        let tag = &rest[..=end];

        if tag.starts_with("</") {
            out.push_str(tag);
        } else if tag.starts_with("<?") || tag.starts_with("<!") {
            out.push_str(tag);
        } else {
            let name = tag_name(tag);
            let is_element = matches!(name, "node" | "way" | "relation");
            let has_changeset = tag
                .split_whitespace()
                .any(|part| part.starts_with("changeset="));

            if is_element && !has_changeset {
                let insert_at = 1 + name.len();
                out.push_str(&tag[..insert_at]);
                out.push_str(&format!(" changeset=\"{changeset_id}\""));
                out.push_str(&tag[insert_at..]);
            } else {
                out.push_str(tag);
            }
        }

        rest = &rest[end + 1..];
    }

    out.push_str(rest);
    out
}


fn build_changeset_xml(comment: &str, extra_tags: &[(String, String)]) -> String {
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<osm>\n  <changeset>\n");
    let mut tags: Vec<(String, String)> = Vec::new();
    if !comment.trim().is_empty() {
        tags.push(("comment".to_string(), comment.trim().to_string()));
    }
    tags.push(("created_by".to_string(), CHANGESET_CREATED_BY.to_string()));
    for (key, value) in extra_tags {
        let key = key.trim();
        if key.is_empty() || key == "created_by" || key == "comment" {
            continue;
        }
        tags.push((key.to_string(), value.clone()));
    }

    for (key, value) in tags {
        xml.push_str(&format!(
            "    <tag k=\"{}\" v=\"{}\" />\n",
            xml_escape(&key),
            xml_escape(&value)
        ));
    }
    xml.push_str("  </changeset>\n</osm>\n");
    xml
}

fn xml_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

/// Count the elements the diff actually adds, changes and removes.
///
/// `diffResult` only reports the id mapping, so the counts come from the
/// document we uploaded.
fn count_diff_elements(diff: &str) -> (usize, usize, usize) {
    let mut section = "";
    let mut counts = (0usize, 0usize, 0usize);
    let mut rest = diff;

    while let Some(offset) = rest.find('<') {
        rest = &rest[offset..];
        let Some(end) = rest.find('>') else { break };
        let tag = &rest[..=end];

        if tag.starts_with("</") {
            let name = tag_name(tag);
            if matches!(name, "create" | "modify" | "delete") {
                section = "";
            }
        } else if !tag.starts_with("<?") && !tag.starts_with("<!") {
            let name = tag_name(tag);
            if matches!(name, "create" | "modify" | "delete") {
                section = name;
            } else if matches!(name, "node" | "way" | "relation") {
                match section {
                    "create" => counts.0 += 1,
                    "modify" => counts.1 += 1,
                    "delete" => counts.2 += 1,
                    _ => {}
                }
            }
        }

        rest = &rest[end + 1..];
    }

    counts
}

fn truncate(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_changeset_with_escaped_tags() {
        let xml = build_changeset_xml(
            "Fix \"broken\" & missing road",
            &[("source".to_string(), "survey".to_string())],
        );
        assert!(xml.contains("<tag k=\"comment\" v=\"Fix &quot;broken&quot; &amp; missing road\" />"));
        assert!(xml.contains("<tag k=\"created_by\" v=\"BetteriD privacy upload\" />"));
        assert!(xml.contains("<tag k=\"source\" v=\"survey\" />"));
    }

    #[test]
    fn ignores_reserved_extra_tags() {
        let xml = build_changeset_xml(
            "hello",
            &[
                ("comment".to_string(), "override".to_string()),
                ("created_by".to_string(), "override".to_string()),
            ],
        );
        assert_eq!(xml.matches("k=\"comment\"").count(), 1);
        assert_eq!(xml.matches("k=\"created_by\"").count(), 1);
        assert!(!xml.contains("override"));
    }

    #[test]
    fn stamps_the_changeset_id_into_the_diff() {
        let diff = "<osmChange version=\"0.6\"><create><node id=\"-1\" lat=\"1\" lon=\"2\" /><node id=\"-2\" lat=\"3\" lon=\"4\"><tag k=\"a\" v=\"b\" /></node></create><modify><way id=\"5\"><nd ref=\"6\" /></way></modify><delete><node id=\"7\" version=\"3\" /></delete></osmChange>";
        let stamped = inject_changeset(diff, 123456);

        assert_eq!(stamped.matches("changeset=\"123456\"").count(), 4);
        assert!(stamped.contains("<node changeset=\"123456\" id=\"-1\" lat=\"1\" lon=\"2\" />"));
        assert!(stamped.contains("<way changeset=\"123456\" id=\"5\">"));
        assert!(stamped.contains("<node changeset=\"123456\" id=\"7\" version=\"3\" />"));
        // untouched corners
        assert!(stamped.contains("<tag k=\"a\" v=\"b\" />"));
        assert!(stamped.contains("<nd ref=\"6\" />"));
    }

    #[test]
    fn keeps_an_existing_changeset_attribute() {
        let diff = "<osmChange><create><node id=\"-1\" changeset=\"9\" lat=\"1\" lon=\"2\" /></create></osmChange>";
        let stamped = inject_changeset(diff, 123456);
        assert_eq!(stamped.matches("changeset=").count(), 1);
        assert!(stamped.contains("changeset=\"9\""));
    }

    #[test]
    fn counts_diff_elements_by_section() {
        let xml = "<osmChange version=\"0.6\"><create><node id=\"-1\"/><way id=\"-2\"><nd ref=\"-1\"/></way></create><modify><node id=\"3\"/></modify><delete><node id=\"4\"/></delete></osmChange>";
        assert_eq!(count_diff_elements(xml), (2, 1, 1));
        assert_eq!(count_diff_elements("<osmChange></osmChange>"), (0, 0, 0));
    }
}
