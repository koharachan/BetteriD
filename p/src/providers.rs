use std::fmt;

use serde::Deserializer;
use serde::de::{Error, SeqAccess, Visitor};

pub const MAX_PROVIDER_ORDER_ITEMS: usize = 8;
pub const MAX_PROVIDER_NAME_BYTES: usize = 32;

struct ProviderOrderVisitor;

impl<'de> Visitor<'de> for ProviderOrderVisitor {
    type Value = Vec<String>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "at most {MAX_PROVIDER_ORDER_ITEMS} provider names of at most {MAX_PROVIDER_NAME_BYTES} bytes"
        )
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut providers = Vec::with_capacity(MAX_PROVIDER_ORDER_ITEMS);
        while let Some(provider) = sequence.next_element::<String>()? {
            if providers.len() == MAX_PROVIDER_ORDER_ITEMS {
                return Err(A::Error::custom("too many providers"));
            }
            if provider.len() > MAX_PROVIDER_NAME_BYTES {
                return Err(A::Error::custom("provider name is too long"));
            }
            providers.push(provider);
        }
        Ok(providers)
    }
}

pub fn deserialize_provider_order<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    deserializer.deserialize_seq(ProviderOrderVisitor)
}

pub fn deserialize_optional_provider_order<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    struct OptionalProviderOrderVisitor;

    impl<'de> Visitor<'de> for OptionalProviderOrderVisitor {
        type Value = Option<Vec<String>>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a bounded provider list or null")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserialize_provider_order(deserializer).map(Some)
        }
    }

    deserializer.deserialize_option(OptionalProviderOrderVisitor)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Request {
        #[serde(default, deserialize_with = "deserialize_provider_order")]
        provider_order: Vec<String>,
    }

    #[test]
    fn provider_order_is_bounded_during_deserialization() {
        let valid: Request = serde_json::from_str(r#"{"provider_order":["openai","mimo"]}"#)
            .expect("valid provider order");
        assert_eq!(valid.provider_order, ["openai", "mimo"]);

        let too_many = serde_json::json!({
            "provider_order": vec!["openai"; MAX_PROVIDER_ORDER_ITEMS + 1]
        });
        assert!(serde_json::from_value::<Request>(too_many).is_err());
    }
}
