use log::{debug, error};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Bing (Azure Cognitive Services) Translator.
///
/// Uses the Microsoft Translator Text API v3.0 to translate text between
/// languages. Supports batch translation — up to 25 strings per request.
#[derive(Clone)]
pub struct Translator {
    api_key: String,
    client: reqwest::Client,
    region: String,
}

#[derive(Debug, Serialize)]
struct TranslateRequest {
    #[serde(rename = "Text")]
    text: String,
}

#[derive(Debug, Deserialize)]
struct TranslateResponseItem {
    #[allow(dead_code)]
    #[serde(rename = "detectedLanguage")]
    detected_language: Option<DetectedLanguage>,
    translations: Vec<TranslationResult>,
}

#[derive(Debug, Deserialize)]
struct DetectedLanguage {
    #[allow(dead_code)]
    language: String,
    #[allow(dead_code)]
    score: f64,
}

#[derive(Debug, Deserialize)]
struct TranslationResult {
    text: String,
    to: String,
}

/// Result of a batch translation call.
#[derive(Debug, Clone)]
pub struct BatchTranslation {
    pub zh_cn: String,
    pub zh_tw: String,
    pub en: String,
}

/// Keyless MyMemory translation client used before the paid AI fallback.
#[derive(Clone)]
pub struct FreeTranslator {
    client: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct MyMemoryResponse {
    #[serde(rename = "responseData")]
    response_data: MyMemoryResponseData,
    #[serde(rename = "responseDetails", default)]
    response_details: String,
    #[serde(rename = "responseStatus")]
    response_status: u16,
}

#[derive(Debug, Deserialize)]
struct MyMemoryResponseData {
    #[serde(rename = "translatedText")]
    translated_text: String,
}

impl FreeTranslator {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .gzip(true)
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap();
        Self { client }
    }

    /// Translate into the three name locales without requiring an API key.
    pub async fn translate_three(&self, text: &str) -> Option<BatchTranslation> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }

        let (zh_cn, zh_tw, en) = tokio::join!(
            self.translate(text, "zh-CN"),
            self.translate(text, "zh-TW"),
            self.translate(text, "en")
        );

        Some(BatchTranslation {
            zh_cn: zh_cn?,
            zh_tw: zh_tw?,
            en: en?,
        })
    }

    async fn translate(&self, text: &str, target: &str) -> Option<String> {
        let lang_pair = format!("Autodetect|{}", target);
        let response = match self
            .client
            .get("https://api.mymemory.translated.net/get")
            .query(&[("q", text), ("langpair", lang_pair.as_str())])
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                error!("MyMemory request failed: {}", err);
                return None;
            }
        };

        if !response.status().is_success() {
            error!("MyMemory HTTP error {}", response.status());
            return None;
        }

        let result = match response.json::<MyMemoryResponse>().await {
            Ok(result) => result,
            Err(err) => {
                error!("Failed to parse MyMemory response: {}", err);
                return None;
            }
        };

        if result.response_status == 200 {
            let translated = result.response_data.translated_text.trim().to_string();
            return (!translated.is_empty()).then_some(translated);
        }

        // MyMemory rejects a source and target that are already the same language.
        // In that case, the source text is already the correct translation.
        if result.response_status == 403
            && result
                .response_details
                .contains("SELECT TWO DISTINCT LANGUAGES")
        {
            return Some(text.to_string());
        }

        error!(
            "MyMemory translation error {}: {}",
            result.response_status, result.response_details
        );
        None
    }
}

impl Translator {
    pub fn new(api_key: String, region: String) -> Self {
        let client = reqwest::Client::builder().gzip(true).build().unwrap();
        Self {
            api_key,
            client,
            region,
        }
    }

    /// Translate text into zh-CN, zh-TW, and en in a single API call.
    /// Returns `None` if the API key is empty or the request fails.
    pub async fn translate_three(&self, text: &str) -> Option<BatchTranslation> {
        if text.trim().is_empty() {
            return None;
        }

        let body = vec![TranslateRequest {
            text: text.to_string(),
        }];

        match self
            .client
            .post("https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans&to=zh-Hant&to=en")
            .header("Ocp-Apim-Subscription-Key", &self.api_key)
            .header("Ocp-Apim-Subscription-Region", &self.region)
            .json(&body)
            .send()
            .await
        {
            Ok(response) => {
                if !response.status().is_success() {
                    let status = response.status();
                    error!("Bing Translate API error {}", status);
                    return None;
                }
                match response.json::<Vec<TranslateResponseItem>>().await {
                    Ok(items) => {
                        if let Some(item) = items.into_iter().next() {
                            let mut zh_cn = String::new();
                            let mut zh_tw = String::new();
                            let mut en = String::new();
                            for t in item.translations {
                                match t.to.as_str() {
                                    "zh-Hans" => zh_cn = t.text,
                                    "zh-Hant" => zh_tw = t.text,
                                    "en" => en = t.text,
                                    _ => {}
                                }
                            }
                            debug!("Translated a multilingual name successfully");
                            Some(BatchTranslation { zh_cn, zh_tw, en })
                        } else {
                            None
                        }
                    }
                    Err(e) => {
                        error!("Failed to parse Bing Translate response: {}", e);
                        None
                    }
                }
            }
            Err(e) => {
                error!("Bing Translate request failed: {}", e);
                None
            }
        }
    }

    /// Translate text into a single target language.
    pub async fn translate(&self, text: &str, to_lang: &str) -> Option<String> {
        if text.trim().is_empty() {
            return None;
        }

        // Map our locale codes to MS Translator locale codes.
        let azure_lang = match to_lang {
            "zh-CN" | "zh-Hans" => "zh-Hans",
            "zh-TW" | "zh-Hant" => "zh-Hant",
            other => other,
        };

        let body = vec![TranslateRequest {
            text: text.to_string(),
        }];

        let url = format!(
            "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to={}",
            azure_lang
        );

        match self
            .client
            .post(&url)
            .header("Ocp-Apim-Subscription-Key", &self.api_key)
            .header("Ocp-Apim-Subscription-Region", &self.region)
            .json(&body)
            .send()
            .await
        {
            Ok(response) => {
                if !response.status().is_success() {
                    let status = response.status();
                    error!("Bing Translate API error {}", status);
                    return None;
                }
                match response.json::<Vec<TranslateResponseItem>>().await {
                    Ok(items) => {
                        if let Some(item) = items.into_iter().next() {
                            if let Some(t) = item.translations.into_iter().next() {
                                return Some(t.text);
                            }
                        }
                        None
                    }
                    Err(e) => {
                        error!("Failed to parse Bing Translate response: {}", e);
                        None
                    }
                }
            }
            Err(e) => {
                error!("Bing Translate request failed: {}", e);
                None
            }
        }
    }

    /// Check whether the translator is configured (has an API key).
    pub fn is_configured(&self) -> bool {
        !self.api_key.is_empty()
    }
}

// ─── Name localisation helper ─────────────────────────────────────────

/// Generate a multi‑language name tag set from a source name string.
///
/// If a Bing Translate API key is configured, live translation is used.
/// Otherwise falls back to preset translations for known tag values.
pub async fn generate_multilingual_name(
    translator: &Option<Translator>,
    name: &str,
    tag_key: &str,
    tag_value: &str,
) -> Option<BatchTranslation> {
    // Try live translation first.
    if let Some(t) = translator {
        if t.is_configured() {
            if let Some(bt) = t.translate_three(name).await {
                return Some(bt);
            }
        }
    }

    // Fall back to preset translations for well‑known tag+value combos.
    let lookup = format!("{}={}", tag_key, tag_value);
    if let Some(preset) = crate::config::get_preset_translations().get(lookup.as_str()) {
        return Some(BatchTranslation {
            zh_cn: preset.zh_cn.to_string(),
            zh_tw: preset.zh_tw.to_string(),
            en: preset.en.to_string(),
        });
    }

    // Also try just the value (e.g. for "building=yes", try "building=yes" lookup which
    // we already did above, but if that didn't match, try key-only match).
    let key_lookup = format!("{}=", tag_key);
    if let Some(preset) = crate::config::get_preset_translations().get(key_lookup.as_str()) {
        return Some(BatchTranslation {
            zh_cn: preset.zh_cn.to_string(),
            zh_tw: preset.zh_tw.to_string(),
            en: preset.en.to_string(),
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_mymemory_response() {
        let result: MyMemoryResponse = serde_json::from_str(
            r#"{"responseData":{"translatedText":"Donghe Road"},"responseDetails":"","responseStatus":200}"#,
        )
        .unwrap();

        assert_eq!(result.response_status, 200);
        assert_eq!(result.response_data.translated_text, "Donghe Road");
    }

    #[tokio::test]
    async fn test_translator_no_key() {
        // Without an API key, translation should return None gracefully.
        let t = Translator::new(String::new(), "global".to_string());
        assert!(!t.is_configured());
        let result = t.translate_three("学校").await;
        assert!(result.is_none());
    }

    #[test]
    fn test_preset_translation_lookup() {
        let presets = crate::config::get_preset_translations();
        let school = presets.get("amenity=school").unwrap();
        assert_eq!(school.zh_cn, "学校区域");
        assert_eq!(school.zh_tw, "學校區域");
        assert_eq!(school.en, "School Area");

        let house = presets.get("building=house").unwrap();
        assert_eq!(house.en, "House");
    }

    #[test]
    fn test_preset_translation_get() {
        let presets = crate::config::get_preset_translations();
        let entry = presets.get("amenity=hospital").unwrap();
        assert_eq!(entry.get("zh-CN"), "医院");
        assert_eq!(entry.get("zh-TW"), "醫院");
        assert_eq!(entry.get("en"), "Hospital");
        // Unknown language falls back to English.
        assert_eq!(entry.get("fr"), "Hospital");
    }
}
