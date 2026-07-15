use std::cmp::Ordering;

use log::{debug, info};
use serde_json::Value;

use crate::config::SplitStrategy;

/// Smart changeset splitter.
///
/// Large changesets are common when editing OSM data, but they are more
/// likely to produce conflicts (especially with less‑experienced editors).
/// This splitter breaks a large changeset into several smaller ones so that
/// each can be submitted independently and reviewed more easily.
#[derive(Debug, Clone)]
pub struct SmartSplitter {
    strategy: SplitStrategy,
}

/// Represents a single element (node, way, or relation) in a changeset.
#[derive(Debug, Clone)]
pub struct OsmElement {
    #[allow(dead_code)]
    pub osm_type: String, // "node", "way", or "relation"
    pub id: Option<i64>, // negative = new, positive = existing
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub tags: Vec<(String, String)>,
    #[allow(dead_code)]
    pub nodes: Vec<i64>, // for ways — references to node ids
    #[allow(dead_code)]
    pub members: Vec<(String, String, String)>, // for relations — (type, ref, role)
    pub raw: serde_json::Value,
}

/// One sub‑changeset produced by the splitter.
#[derive(Debug, Clone)]
pub struct SubChangeset {
    pub elements: Vec<serde_json::Value>,
    pub description: String,
}

impl SmartSplitter {
    pub fn new(strategy: SplitStrategy) -> Self {
        Self { strategy }
    }

    /// Parse an OSM changeset body and decide whether splitting is needed.
    /// Returns `None` if the changeset is small enough to keep as‑is.
    pub fn should_split(&self, body: &str) -> bool {
        let elements = match Self::parse_elements(body) {
            Ok(elems) => elems,
            Err(_) => return false,
        };

        if elements.is_empty() {
            return false;
        }

        // Always split if there are more than 100 elements regardless of
        // strategy — this is an absolute safety limit.
        if elements.len() > 100 {
            return true;
        }

        if let Some(fixed) = self.strategy.fixed_changes {
            if elements.len() > fixed {
                return true;
            }
        }

        false
    }

    /// Split a changeset body into sub‑changesets.
    ///
    /// Strategy:
    /// - **area_based** (default): cluster elements by geographic proximity
    ///   so that nearby elements go together.
    /// - **fixed**: simply chunk by `fixed_changes` count regardless of
    ///   geography.
    /// - **auto_detect**: if the bbox of all elements is large (>1°), use
    ///   area‑based; otherwise use fixed.
    pub fn split(&self, body: &str) -> Result<Vec<SubChangeset>, String> {
        let elements = Self::parse_elements(body)?;
        if elements.is_empty() {
            return Ok(Vec::new());
        }

        let threshold = self.strategy.fixed_changes.unwrap_or(50);

        let use_area = if self.strategy.auto_detect {
            Self::detect_large_area(&elements, 1.0)
        } else {
            self.strategy.area_based
        };

        let groups: Vec<Vec<OsmElement>> = if use_area {
            self.cluster_by_proximity(elements, threshold)
        } else {
            elements.chunks(threshold).map(|c| c.to_vec()).collect()
        };

        let total = groups.len();
        let sub_changesets: Vec<SubChangeset> = groups
            .into_iter()
            .enumerate()
            .map(|(i, group)| {
                let desc = if total > 1 {
                    format!("Part {}/{} ({} elements)", i + 1, total, group.len())
                } else {
                    "Changeset".to_string()
                };
                let elems: Vec<serde_json::Value> = group.into_iter().map(|e| e.raw).collect();
                SubChangeset {
                    elements: elems,
                    description: desc,
                }
            })
            .collect();

        info!(
            "Split changeset into {} sub-changesets (area_based={})",
            sub_changesets.len(),
            use_area
        );

        Ok(sub_changesets)
    }

    // ── private helpers ──────────────────────────────────────────────

    fn parse_elements(body: &str) -> Result<Vec<OsmElement>, String> {
        let root: Value = serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;

        let mut elements = Vec::new();

        // Support two formats:
        //  1. { "type": "create"|"modify"|"delete", "elements": [...] }
        //  2. { "osmChange": { "create|modify|delete": [...] } }
        if let Some(elems_array) = root.get("elements").and_then(|v| v.as_array()) {
            for item in elems_array {
                if let Some(elem) = Self::parse_element(item) {
                    elements.push(elem);
                }
            }
        } else if let Some(change) = root.get("osmChange") {
            for action in ["create", "modify", "delete"] {
                if let Some(arr) = change.get(action).and_then(|v| v.as_array()) {
                    for item in arr {
                        if let Some(elem) = Self::parse_element(item) {
                            elements.push(elem);
                        }
                    }
                }
            }
        }

        Ok(elements)
    }

    fn parse_element(val: &Value) -> Option<OsmElement> {
        let osm_type = val
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("node")
            .to_string();
        let id = val.get("id").and_then(|v| v.as_i64());
        let lat = val.get("lat").and_then(|v| v.as_f64());
        let lon = val.get("lon").and_then(|v| v.as_f64());
        let nodes: Vec<i64> = val
            .get("nodes")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|n| n.as_i64()).collect())
            .unwrap_or_default();
        let members: Vec<(String, String, String)> = val
            .get("members")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|m| {
                        let typ = m
                            .get("type")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .to_string();
                        let r#ref = m
                            .get("ref")
                            .and_then(|r| r.as_i64())
                            .map(|r| r.to_string())
                            .unwrap_or_default();
                        let role = m
                            .get("role")
                            .and_then(|r| r.as_str())
                            .unwrap_or("")
                            .to_string();
                        if typ.is_empty() {
                            None
                        } else {
                            Some((typ, r#ref, role))
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let tags: Vec<(String, String)> = val
            .get("tags")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                    .collect()
            })
            .unwrap_or_default();

        Some(OsmElement {
            osm_type,
            id,
            lat,
            lon,
            tags,
            nodes,
            members,
            raw: val.clone(),
        })
    }

    /// Determine whether elements span a large geographic area (> `min_span` degrees).
    fn detect_large_area(elements: &[OsmElement], min_span: f64) -> bool {
        let coords: Vec<(f64, f64)> = elements
            .iter()
            .filter_map(|e| match (e.lat, e.lon) {
                (Some(lat), Some(lon)) => Some((lat, lon)),
                _ => None,
            })
            .collect();

        if coords.len() < 2 {
            return false;
        }

        let (min_lat, max_lat, min_lon, max_lon) = coords.iter().fold(
            (f64::MAX, f64::MIN, f64::MAX, f64::MIN),
            |(min_la, max_la, min_lo, max_lo), &(la, lo)| {
                (
                    min_la.min(la),
                    max_la.max(la),
                    min_lo.min(lo),
                    max_lo.max(lo),
                )
            },
        );

        let lat_span = max_lat - min_lat;
        let lon_span = max_lon - min_lon;

        lat_span > min_span || lon_span > min_span
    }

    /// Simple k‑means–style clustering for elements with coordinates.
    ///
    /// Elements without coordinates are distributed evenly among clusters.
    fn cluster_by_proximity(
        &self,
        elements: Vec<OsmElement>,
        max_per_group: usize,
    ) -> Vec<Vec<OsmElement>> {
        let with_coords: Vec<&OsmElement> = elements
            .iter()
            .filter(|e| e.lat.is_some() && e.lon.is_some())
            .collect();

        let without_coords: Vec<&OsmElement> = elements
            .iter()
            .filter(|e| e.lat.is_none() || e.lon.is_none())
            .collect();

        // If very few elements, return as‑is.
        if elements.len() <= max_per_group {
            return vec![elements];
        }

        let n_groups = ((elements.len() + max_per_group - 1) / max_per_group).max(1);

        // For elements WITH coordinates: sort by (lat, lon) and chunk.
        let mut sorted: Vec<&OsmElement> = with_coords.clone();
        sorted.sort_by(|a, b| {
            let la = a.lat.unwrap_or(0.0);
            let lo = a.lon.unwrap_or(0.0);
            let lb = b.lat.unwrap_or(0.0);
            let lb2 = b.lon.unwrap_or(0.0);
            la.partial_cmp(&lb)
                .unwrap_or(Ordering::Equal)
                .then_with(|| lo.partial_cmp(&lb2).unwrap_or(Ordering::Equal))
        });

        let per_group = (sorted.len() + n_groups - 1) / n_groups;
        let mut groups: Vec<Vec<OsmElement>> = sorted
            .chunks(per_group.max(1))
            .map(|chunk| chunk.iter().map(|e| (*e).clone()).collect())
            .collect();

        // Pad with empty groups if needed.
        while groups.len() < n_groups {
            groups.push(Vec::new());
        }

        // Distribute elements WITHOUT coordinates evenly.
        let n = groups.len();
        for (i, elem) in without_coords.iter().enumerate() {
            groups[i % n].push((*elem).clone());
        }

        // Remove empty groups.
        groups.retain(|g| !g.is_empty());

        debug!(
            "Clustered {} elements into {} groups ({} w/ coords, {} w/o)",
            elements.len(),
            groups.len(),
            with_coords.len(),
            without_coords.len()
        );

        groups
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SplitStrategy;

    #[test]
    fn test_should_not_split_empty() {
        let s = SmartSplitter::new(SplitStrategy::default());
        let body = r#"{"type":"create","elements":[]}"#;
        assert!(!s.should_split(body));
    }

    #[test]
    fn test_should_split_many_elements() {
        let s = SmartSplitter::new(SplitStrategy {
            fixed_changes: Some(3),
            ..SplitStrategy::default()
        });
        // Build a body with 5 elements.
        let mut elems = Vec::new();
        for i in 0..5 {
            elems.push(serde_json::json!({
                "type": "node",
                "id": -i,
                "lat": 24.0 + i as f64 * 0.1,
                "lon": 113.0 + i as f64 * 0.1,
                "tags": {"amenity": "school"}
            }));
        }
        let body = serde_json::json!({"type": "create", "elements": elems}).to_string();
        assert!(s.should_split(&body));
    }

    #[test]
    fn test_parse_elements() {
        let body = r#"{"type":"create","elements":[{"type":"node","id":-1,"lat":24.7,"lon":113.6,"tags":{"amenity":"school"}}]}"#;
        let elems = SmartSplitter::parse_elements(body).unwrap();
        assert_eq!(elems.len(), 1);
        assert_eq!(elems[0].lat, Some(24.7));
        assert_eq!(elems[0].lon, Some(113.6));
    }

    #[test]
    fn test_detect_large_area() {
        let small = vec![
            OsmElement {
                osm_type: "node".into(),
                id: Some(-1),
                lat: Some(24.79),
                lon: Some(113.62),
                tags: vec![],
                nodes: vec![],
                members: vec![],
                raw: serde_json::json!({}),
            },
            OsmElement {
                osm_type: "node".into(),
                id: Some(-2),
                lat: Some(24.80),
                lon: Some(113.63),
                tags: vec![],
                nodes: vec![],
                members: vec![],
                raw: serde_json::json!({}),
            },
        ];
        assert!(!SmartSplitter::detect_large_area(&small, 1.0));

        let large = vec![
            OsmElement {
                osm_type: "node".into(),
                id: Some(-1),
                lat: Some(22.0),
                lon: Some(113.0),
                tags: vec![],
                nodes: vec![],
                members: vec![],
                raw: serde_json::json!({}),
            },
            OsmElement {
                osm_type: "node".into(),
                id: Some(-2),
                lat: Some(24.0),
                lon: Some(116.0),
                tags: vec![],
                nodes: vec![],
                members: vec![],
                raw: serde_json::json!({}),
            },
        ];
        assert!(SmartSplitter::detect_large_area(&large, 1.0));
    }

    #[test]
    fn test_split_area_based() {
        let s = SmartSplitter::new(SplitStrategy {
            fixed_changes: Some(2),
            area_based: true,
            auto_detect: false,
        });
        let mut elems = Vec::new();
        for i in 0..4 {
            elems.push(serde_json::json!({
                "type": "node",
                "id": -i,
                "lat": 24.0 + i as f64 * 0.5,
                "lon": 113.0 + i as f64 * 0.5,
                "tags": {"building": "house"}
            }));
        }
        let body = serde_json::json!({"type": "create", "elements": elems}).to_string();
        let subs = s.split(&body).unwrap();
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].elements.len() + subs[1].elements.len(), 4);
    }
}
