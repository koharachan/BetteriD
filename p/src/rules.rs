#![allow(dead_code)]

use std::collections::HashMap;

#[derive(Clone)]
pub struct ValidationRule {
    pub id: String,
    pub enabled: bool,
}

#[derive(Clone)]
pub struct RuleEngine {
    pub rules: HashMap<String, ValidationRule>,
    pub locale_rules: HashMap<String, Vec<String>>,
}

impl RuleEngine {
    pub fn new(enabled_rules: &[String]) -> Self {
        let mut rules = HashMap::new();

        rules.insert(
            "foreign_name_check".to_string(),
            ValidationRule {
                id: "foreign_name_check".to_string(),
                enabled: enabled_rules.contains(&"foreign_name_check".to_string()),
            },
        );

        rules.insert(
            "missing_name".to_string(),
            ValidationRule {
                id: "missing_name".to_string(),
                enabled: enabled_rules.contains(&"missing_name".to_string()),
            },
        );

        rules.insert(
            "inconsistent_tags".to_string(),
            ValidationRule {
                id: "inconsistent_tags".to_string(),
                enabled: enabled_rules.contains(&"inconsistent_tags".to_string()),
            },
        );

        let mut locale_rules = HashMap::new();
        locale_rules.insert(
            "zh-CN".to_string(),
            vec![
                "zh".to_string(),
                "zh-CN".to_string(),
                "zh-Hans".to_string(),
                "zh-Hans-CN".to_string(),
            ],
        );
        locale_rules.insert(
            "zh-TW".to_string(),
            vec![
                "zh".to_string(),
                "zh-TW".to_string(),
                "zh-Hant".to_string(),
                "zh-Hant-TW".to_string(),
            ],
        );
        locale_rules.insert(
            "ja".to_string(),
            vec!["ja".to_string(), "ja-JP".to_string()],
        );
        locale_rules.insert(
            "en".to_string(),
            vec![
                "en".to_string(),
                "en-US".to_string(),
                "en-GB".to_string(),
                "en-CA".to_string(),
                "en-AU".to_string(),
            ],
        );
        locale_rules.insert(
            "ko".to_string(),
            vec!["ko".to_string(), "ko-KR".to_string()],
        );
        locale_rules.insert(
            "fr".to_string(),
            vec!["fr".to_string(), "fr-FR".to_string(), "fr-CA".to_string()],
        );
        locale_rules.insert(
            "de".to_string(),
            vec!["de".to_string(), "de-DE".to_string()],
        );
        locale_rules.insert(
            "es".to_string(),
            vec!["es".to_string(), "es-ES".to_string(), "es-MX".to_string()],
        );

        Self {
            rules,
            locale_rules,
        }
    }

    pub fn check_foreign_name(
        &self,
        tags: &HashMap<String, String>,
        default_lang: &str,
    ) -> Vec<String> {
        if !self
            .rules
            .get("foreign_name_check")
            .map_or(false, |r| r.enabled)
        {
            return Vec::new();
        }

        let mut issues = Vec::new();
        let default_vec = vec![default_lang.to_string()];
        let allowed_langs = self.locale_rules.get(default_lang).unwrap_or(&default_vec);

        if let Some(name) = tags.get("name") {
            let has_local_name = allowed_langs
                .iter()
                .any(|lang| tags.contains_key(&format!("name:{}", lang)));

            if !has_local_name && !is_local_language(name, default_lang) {
                issues.push(format!(
                    "名称 '{}' 可能不是{}地区的法定语言，建议添加名称翻译",
                    name, default_lang
                ));
            }
        }

        for (key, _value) in tags.iter() {
            if key.starts_with("name:") {
                let lang = key.split(':').nth(1).unwrap_or("");
                if !allowed_langs.contains(&lang.to_string()) {
                    issues.push(format!("标签 {} 使用了非本地语言", key));
                }
            }
        }

        issues
    }

    pub fn check_missing_name(&self, tags: &HashMap<String, String>) -> Vec<String> {
        if !self.rules.get("missing_name").map_or(false, |r| r.enabled) {
            return Vec::new();
        }

        let mut issues = Vec::new();

        if !tags.contains_key("name") {
            let common_tags = vec!["amenity", "shop", "tourism", "building", "highway"];
            for tag in common_tags {
                if tags.contains_key(tag) {
                    issues.push(format!("缺少名称标签，建议添加 name"));
                    break;
                }
            }
        }

        issues
    }

    pub fn check_inconsistent_tags(&self, tags: &HashMap<String, String>) -> Vec<String> {
        if !self
            .rules
            .get("inconsistent_tags")
            .map_or(false, |r| r.enabled)
        {
            return Vec::new();
        }

        let mut issues = Vec::new();

        if tags.contains_key("highway") && tags.contains_key("building") {
            issues.push("highway 和 building 标签同时存在，可能存在冲突".to_string());
        }

        if tags.get("amenity") == Some(&"school".to_string())
            && tags.get("landuse") != Some(&"education".to_string())
        {
            issues.push("amenity=school 建议搭配 landuse=education 使用".to_string());
        }

        if tags.get("natural") == Some(&"water".to_string()) && tags.get("landuse").is_some() {
            issues.push("natural=water 和 landuse 标签可能存在冲突".to_string());
        }

        issues
    }

    pub fn get_rules(&self) -> Vec<ValidationRule> {
        self.rules.values().cloned().collect()
    }
}

fn is_local_language(text: &str, lang: &str) -> bool {
    match lang {
        "zh-CN" | "zh-TW" => contains_cjk(text),
        "ja" => contains_japanese(text),
        "ko" => contains_korean(text),
        "en" => contains_latin(text),
        "fr" => contains_latin(text),
        "de" => contains_latin(text),
        "es" => contains_latin(text),
        _ => true,
    }
}

fn contains_cjk(text: &str) -> bool {
    text.chars().any(|c| {
        let code = c as u32;
        (code >= 0x4E00 && code <= 0x9FFF)
            || (code >= 0x3400 && code <= 0x4DBF)
            || (code >= 0x20000 && code <= 0x2A6DF)
    })
}

fn contains_japanese(text: &str) -> bool {
    text.chars().any(|c| {
        let code = c as u32;
        (code >= 0x3040 && code <= 0x30FF)
            || (code >= 0x4E00 && code <= 0x9FFF)
            || (code >= 0x3000 && code <= 0x303F)
    })
}

fn contains_korean(text: &str) -> bool {
    text.chars().any(|c| {
        let code = c as u32;
        (code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x3130 && code <= 0x318F)
    })
}

fn contains_latin(text: &str) -> bool {
    text.chars().any(|c| {
        let code = c as u32;
        (code >= 0x0041 && code <= 0x005A)
            || (code >= 0x0061 && code <= 0x007A)
            || (code >= 0x00C0 && code <= 0x00FF)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_foreign_name() {
        let engine = RuleEngine::new(&["foreign_name_check".to_string()]);
        let mut tags = HashMap::new();
        tags.insert("name".to_string(), "School".to_string());

        let issues = engine.check_foreign_name(&tags, "zh-CN");
        assert!(!issues.is_empty());
    }

    #[test]
    fn test_check_missing_name() {
        let engine = RuleEngine::new(&["missing_name".to_string()]);
        let mut tags = HashMap::new();
        tags.insert("amenity".to_string(), "school".to_string());

        let issues = engine.check_missing_name(&tags);
        assert!(!issues.is_empty());
    }

    #[test]
    fn test_check_inconsistent_tags() {
        let engine = RuleEngine::new(&["inconsistent_tags".to_string()]);
        let mut tags = HashMap::new();
        tags.insert("highway".to_string(), "residential".to_string());
        tags.insert("building".to_string(), "yes".to_string());

        let issues = engine.check_inconsistent_tags(&tags);
        assert!(!issues.is_empty());
    }
}
