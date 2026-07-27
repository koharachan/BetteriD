use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::net::IpAddr;

#[derive(Debug, Deserialize, Clone)]
pub struct SplitStrategy {
    pub auto_detect: bool,
    pub fixed_changes: Option<usize>,
    pub area_based: bool,
}

impl Default for SplitStrategy {
    fn default() -> Self {
        Self {
            auto_detect: true,
            fixed_changes: Some(50),
            area_based: true,
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct ProxyConfig {
    pub listen_addr: String,
    pub upstream_url: String,
    pub tile_upstream_url: String,
    pub cache_max_size: usize,
    pub cache_default_ttl: u64,
    pub cache_dir: Option<String>,
    pub id_static_dir: String,
    pub osm_oauth_client_id: String,
    pub osm_oauth_redirect_uri: Option<String>,
    pub bing_translate_api_key: Option<String>,
    pub bing_translate_region: String,
    pub deepseek_api_key: Option<String>,
    pub deepseek_base_url: String,
    pub deepseek_model: String,
    pub openai_api_key: Option<String>,
    pub openai_base_url: String,
    pub openai_resolve_ip: Option<String>,
    pub openai_text_model: String,
    pub openai_search_model: String,
    pub openai_moderation_model: String,
    pub openai_vision_model: String,
    pub kimi_api_key: Option<String>,
    pub kimi_base_url: String,
    pub kimi_model: String,
    pub mimo_api_keys: Vec<String>,
    pub mimo_base_url: String,
    pub mimo_text_model: String,
    pub mimo_vision_model: String,
    pub photo_upload_dir: String,
    pub trusted_proxy_ips: Vec<IpAddr>,
    pub default_language: String,
    pub enabled_rules: Vec<String>,
    pub enable_smart_split: bool,
    pub split_strategy: SplitStrategy,
    pub proxy_all_tiles: bool,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            listen_addr: "127.0.0.1:9178".to_string(),
            upstream_url: "https://www.openstreetmap.org".to_string(),
            tile_upstream_url: "https://tile.openstreetmap.org".to_string(),
            cache_max_size: 10000,
            cache_default_ttl: 1800,
            cache_dir: Some("./cache".to_string()),
            id_static_dir: "../dist".to_string(),
            osm_oauth_client_id: "ASM8cOEBbmYIZG89l1Xagbx037aD7fc49t_TcEGU8SU".to_string(),
            osm_oauth_redirect_uri: None,
            bing_translate_api_key: None,
            bing_translate_region: "global".to_string(),
            deepseek_api_key: None,
            deepseek_base_url: "https://api.deepseek.com/v1".to_string(),
            deepseek_model: "deepseek-v4-flash".to_string(),
            openai_api_key: None,
            openai_base_url: "https://api.openai.com/v1".to_string(),
            openai_resolve_ip: None,
            openai_text_model: "gpt-5.4-mini".to_string(),
            openai_search_model: "gpt-5.4-mini".to_string(),
            openai_moderation_model: "gpt-5.4-mini".to_string(),
            openai_vision_model: "gpt-5.6-sol".to_string(),
            kimi_api_key: None,
            kimi_base_url: "https://api.moonshot.cn/v1".to_string(),
            kimi_model: "kimi-k2.6".to_string(),
            mimo_api_keys: Vec::new(),
            mimo_base_url: "https://api.xiaomimimo.com/v1".to_string(),
            mimo_text_model: "mimo-v2.5".to_string(),
            mimo_vision_model: "mimo-v2-omni".to_string(),
            photo_upload_dir: "./photo-uploads".to_string(),
            trusted_proxy_ips: Vec::new(),
            default_language: "zh-CN".to_string(),
            enabled_rules: vec!["foreign_name_check".to_string()],
            enable_smart_split: false,
            split_strategy: SplitStrategy::default(),
            proxy_all_tiles: true,
        }
    }
}

fn normalize_value(value: String) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

impl ProxyConfig {
    pub fn load() -> Self {
        let file_values = read_env_files();
        let value = |key: &str| match env::var(key) {
            Ok(value) => normalize_value(value),
            Err(_) => file_values.get(key).cloned().and_then(normalize_value),
        };
        let mut config = Self::default();

        if let Some(v) = value("OSM_LISTEN_ADDR") {
            config.listen_addr = v;
        }
        if let Some(v) = value("OSM_UPSTREAM_URL") {
            config.upstream_url = v;
        }
        if let Some(v) = value("OSM_TILE_UPSTREAM_URL") {
            config.tile_upstream_url = v;
        }
        if let Some(v) = value("OSM_CACHE_DIR") {
            config.cache_dir = Some(v);
        }
        if let Some(v) = value("OSM_ID_DIST_DIR") {
            config.id_static_dir = v;
        }
        if let Some(v) = value("OSM_OAUTH_CLIENT_ID") {
            config.osm_oauth_client_id = v;
        }
        if let Some(v) = value("OSM_OAUTH_REDIRECT_URI") {
            config.osm_oauth_redirect_uri = Some(v);
        }
        if let Some(v) = value("BING_TRANSLATE_API_KEY") {
            config.bing_translate_api_key = Some(v);
        }
        if let Some(v) = value("BING_TRANSLATE_REGION") {
            config.bing_translate_region = v;
        }
        if let Some(v) = value("DEEPSEEK_API_KEY") {
            config.deepseek_api_key = Some(v);
        }
        if let Some(v) = value("DEEPSEEK_BASE_URL") {
            config.deepseek_base_url = v;
        }
        if let Some(v) = value("DEEPSEEK_MODEL") {
            config.deepseek_model = v;
        }
        if let Some(v) = value("OPENAI_API_KEY") {
            config.openai_api_key = Some(v);
        }
        if let Some(v) = value("OPENAI_BASE_URL") {
            config.openai_base_url = v;
        }
        if let Some(v) = value("OPENAI_RESOLVE_IP") {
            config.openai_resolve_ip = Some(v);
        }
        if let Some(v) = value("OPENAI_TEXT_MODEL") {
            config.openai_text_model = v;
        }
        if let Some(v) = value("OPENAI_SEARCH_MODEL") {
            config.openai_search_model = v;
        }
        if let Some(v) = value("OPENAI_MODERATION_MODEL") {
            config.openai_moderation_model = v;
        }
        if let Some(v) = value("OPENAI_VISION_MODEL") {
            config.openai_vision_model = v;
        }
        if let Some(v) = value("KIMI_API_KEY") {
            config.kimi_api_key = Some(v);
        }
        if let Some(v) = value("KIMI_BASE_URL") {
            config.kimi_base_url = v;
        }
        if let Some(v) = value("KIMI_MODEL") {
            config.kimi_model = v;
        }
        if let Some(v) = value("MIMO_API_KEYS") {
            config.mimo_api_keys = split_secrets(&v);
        } else if let Some(v) = value("MIMO_API_KEY") {
            config.mimo_api_keys = split_secrets(&v);
        }
        if let Some(v) = value("MIMO_BASE_URL") {
            config.mimo_base_url = v;
        }
        if let Some(v) = value("MIMO_TEXT_MODEL") {
            config.mimo_text_model = v;
        }
        if let Some(v) = value("MIMO_VISION_MODEL") {
            config.mimo_vision_model = v;
        }
        if let Some(v) = value("OSM_PHOTO_UPLOAD_DIR") {
            config.photo_upload_dir = v;
        }
        if let Some(v) = value("OSM_TRUSTED_PROXY_IPS") {
            config.trusted_proxy_ips = split_ip_addresses(&v);
        }
        if let Some(v) = value("OSM_DEFAULT_LANGUAGE") {
            config.default_language = v;
        }
        if let Some(v) = value("OSM_ENABLED_RULES") {
            config.enabled_rules = v
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect();
        }
        if let Some(v) = value("OSM_ENABLE_SMART_SPLIT") {
            config.enable_smart_split =
                matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on");
        }
        if let Some(v) = value("OSM_PROXY_ALL_TILES") {
            config.proxy_all_tiles =
                matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on");
        }
        if let Some(v) = value("OSM_SPLIT_FIXED_CHANGES") {
            config.split_strategy.fixed_changes = v.parse().ok();
        }
        if let Some(v) = value("OSM_SPLIT_AREA_BASED") {
            config.split_strategy.area_based =
                matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on");
        }
        if let Some(v) = value("OSM_SPLIT_AUTO_DETECT") {
            config.split_strategy.auto_detect =
                matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on");
        }
        if let Some(v) = value("OSM_CACHE_MAX_SIZE").and_then(|item| item.parse().ok()) {
            config.cache_max_size = v;
        }
        if let Some(v) = value("OSM_CACHE_DEFAULT_TTL").and_then(|item| item.parse().ok()) {
            config.cache_default_ttl = v;
        }

        config
    }
}

fn split_secrets(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn split_ip_addresses(value: &str) -> Vec<IpAddr> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .filter_map(|item| item.parse().ok())
        .collect()
}

fn read_env_files() -> HashMap<String, String> {
    let mut values = HashMap::new();
    for path in [".env", "../.env"] {
        let Ok(contents) = fs::read_to_string(path) else {
            continue;
        };
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, raw_value)) = line.split_once('=') else {
                continue;
            };
            let value = raw_value.trim().trim_matches('\"').to_string();
            values.entry(key.trim().to_string()).or_insert(value);
        }
    }
    values
}

#[cfg(test)]
mod tests {
    use super::{ProxyConfig, normalize_value, split_ip_addresses, split_secrets};

    #[test]
    fn tile_proxy_is_enabled_by_default() {
        assert!(ProxyConfig::default().proxy_all_tiles);
    }

    #[test]
    fn normalize_value_ignores_empty_values() {
        assert_eq!(normalize_value(String::new()), None);
        assert_eq!(normalize_value("   ".to_string()), None);
    }

    #[test]
    fn normalize_value_trims_configured_values() {
        assert_eq!(
            normalize_value("  configured  ".to_string()),
            Some("configured".to_string())
        );
    }

    #[test]
    fn split_secrets_ignores_empty_items() {
        assert_eq!(split_secrets(" first, ,second "), ["first", "second"]);
    }

    #[test]
    fn trusted_proxy_list_only_accepts_ip_addresses() {
        assert_eq!(
            split_ip_addresses("127.0.0.1, invalid, ::1"),
            [
                "127.0.0.1".parse::<std::net::IpAddr>().unwrap(),
                "::1".parse::<std::net::IpAddr>().unwrap()
            ]
        );
    }
}

#[derive(Debug, Clone)]
pub struct LayerConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    pub attribution: String,
    pub r#type: String,
}

pub fn get_custom_layers() -> Vec<LayerConfig> {
    vec![
        LayerConfig {
            id: "esri-world-imagery".to_string(),
            name: "Esri 世界影像".to_string(),
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}".to_string(),
            attribution: "© Esri, DigitalGlobe, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN, and the GIS User Community".to_string(),
            r#type: "raster".to_string(),
        },
    ]
}

// ─── Preset translations ───────────────────────────────────────────────
//
// Each entry maps an OSM tag value to translations in zh-CN, zh-TW, and en.
// These are shown as suggestions in the iD editor for common tags.
// The database covers the most frequently used tag values.

#[derive(Debug, Clone)]
pub struct PresetTranslation {
    pub zh_cn: &'static str,
    pub zh_tw: &'static str,
    pub en: &'static str,
}

impl PresetTranslation {
    pub fn get(&self, lang: &str) -> &str {
        match lang {
            "zh-CN" | "zh-Hans" => self.zh_cn,
            "zh-TW" | "zh-Hant" => self.zh_tw,
            _ => self.en,
        }
    }
}

pub fn get_preset_translations() -> HashMap<&'static str, PresetTranslation> {
    let mut m = HashMap::new();

    // ── amenity ────────────────────────────────────────────────────
    m.insert("amenity=school", t("学校区域", "學校區域", "School Area"));
    m.insert("amenity=university", t("大学", "大學", "University"));
    m.insert("amenity=college", t("学院", "學院", "College"));
    m.insert("amenity=hospital", t("医院", "醫院", "Hospital"));
    m.insert("amenity=clinic", t("诊所", "診所", "Clinic"));
    m.insert("amenity=pharmacy", t("药店", "藥局", "Pharmacy"));
    m.insert("amenity=restaurant", t("餐厅", "餐廳", "Restaurant"));
    m.insert("amenity=cafe", t("咖啡馆", "咖啡館", "Café"));
    m.insert("amenity=fast_food", t("快餐店", "速食店", "Fast Food"));
    m.insert("amenity=bar", t("酒吧", "酒吧", "Bar"));
    m.insert("amenity=pub", t("酒馆", "酒館", "Pub"));
    m.insert("amenity=bank", t("银行", "銀行", "Bank"));
    m.insert("amenity=atm", t("自动取款机", "自動提款機", "ATM"));
    m.insert("amenity=post_office", t("邮局", "郵局", "Post Office"));
    m.insert("amenity=police", t("警察局", "警察局", "Police Station"));
    m.insert(
        "amenity=fire_station",
        t("消防站", "消防站", "Fire Station"),
    );
    m.insert("amenity=library", t("图书馆", "圖書館", "Library"));
    m.insert("amenity=theatre", t("剧院", "劇院", "Theatre"));
    m.insert("amenity=cinema", t("电影院", "電影院", "Cinema"));
    m.insert("amenity=marketplace", t("市场", "市場", "Marketplace"));
    m.insert("amenity=fuel", t("加油站", "加油站", "Fuel Station"));
    m.insert("amenity=parking", t("停车场", "停車場", "Parking"));
    m.insert(
        "amenity=bicycle_parking",
        t("自行车停车场", "自行車停車場", "Bicycle Parking"),
    );
    m.insert(
        "amenity=toilets",
        t("公共厕所", "公共廁所", "Public Toilets"),
    );
    m.insert("amenity=shelter", t("避雨棚", "避雨棚", "Shelter"));
    m.insert("amenity=bench", t("长椅", "長椅", "Bench"));
    m.insert(
        "amenity=waste_basket",
        t("垃圾桶", "垃圾桶", "Waste Basket"),
    );
    m.insert(
        "amenity=drinking_water",
        t("饮水处", "飲水處", "Drinking Water"),
    );
    m.insert(
        "amenity=place_of_worship",
        t("宗教场所", "宗教場所", "Place of Worship"),
    );
    m.insert("amenity=townhall", t("市政厅", "市政廳", "Town Hall"));
    m.insert("amenity=courthouse", t("法院", "法院", "Courthouse"));
    m.insert("amenity=prison", t("监狱", "監獄", "Prison"));
    m.insert(
        "amenity=community_centre",
        t("社区中心", "社區中心", "Community Centre"),
    );
    m.insert(
        "amenity=social_facility",
        t("社会服务机构", "社會服務機構", "Social Facility"),
    );
    m.insert(
        "amenity=swimming_pool",
        t("游泳池", "游泳池", "Swimming Pool"),
    );
    m.insert(
        "amenity=sports_centre",
        t("体育中心", "體育中心", "Sports Centre"),
    );
    m.insert("amenity=stadium", t("体育场", "體育場", "Stadium"));
    m.insert("amenity=museum", t("博物馆", "博物館", "Museum"));
    m.insert(
        "amenity=arts_centre",
        t("艺术中心", "藝術中心", "Arts Centre"),
    );
    m.insert("amenity=grave_yard", t("墓地", "墓地", "Graveyard"));
    m.insert("amenity=bus_station", t("公交站", "公車站", "Bus Station"));
    m.insert("amenity=taxi", t("出租车站", "計程車站", "Taxi Stand"));
    m.insert(
        "amenity=ferry_terminal",
        t("渡轮码头", "渡輪碼頭", "Ferry Terminal"),
    );
    m.insert(
        "amenity=vending_machine",
        t("自动售货机", "自動販賣機", "Vending Machine"),
    );
    m.insert(
        "amenity=recycling",
        t("回收点", "回收點", "Recycling Point"),
    );

    // ── building ───────────────────────────────────────────────────
    m.insert("building=yes", t("建筑物", "建築物", "Building"));
    m.insert("building=house", t("独立住宅", "獨立住宅", "House"));
    m.insert(
        "building=residential",
        t("居住建筑", "居住建築", "Residential Building"),
    );
    m.insert(
        "building=detached",
        t("独栋房屋", "獨棟房屋", "Detached House"),
    );
    m.insert(
        "building=semidetached_house",
        t("半独立住宅", "半獨立住宅", "Semi-Detached House"),
    );
    m.insert(
        "building=terrace",
        t("联排房屋", "連排房屋", "Terraced House"),
    );
    m.insert(
        "building=apartments",
        t("公寓楼", "公寓樓", "Apartment Building"),
    );
    m.insert("building=bungalow", t("平房", "平房", "Bungalow"));
    m.insert("building=villa", t("别墅", "別墅", "Villa"));
    m.insert("building=dormitory", t("宿舍楼", "宿舍樓", "Dormitory"));
    m.insert("building=hotel", t("酒店", "酒店", "Hotel"));
    m.insert("building=garage", t("车库", "車庫", "Garage"));
    m.insert("building=garages", t("车库群", "車庫群", "Garages"));
    m.insert("building=shed", t("棚屋", "棚屋", "Shed"));
    m.insert(
        "building=industrial",
        t("工业建筑", "工業建築", "Industrial Building"),
    );
    m.insert("building=warehouse", t("仓库", "倉庫", "Warehouse"));
    m.insert(
        "building=commercial",
        t("商业建筑", "商業建築", "Commercial Building"),
    );
    m.insert(
        "building=retail",
        t("零售建筑", "零售建築", "Retail Building"),
    );
    m.insert("building=office", t("办公楼", "辦公樓", "Office Building"));
    m.insert("building=shop", t("商店", "商店", "Shop"));
    m.insert("building=school", t("教学楼", "教學樓", "School Building"));
    m.insert(
        "building=university",
        t("大学建筑", "大學建築", "University Building"),
    );
    m.insert(
        "building=hospital",
        t("医院大楼", "醫院大樓", "Hospital Building"),
    );
    m.insert("building=church", t("教堂", "教堂", "Church"));
    m.insert("building=mosque", t("清真寺", "清真寺", "Mosque"));
    m.insert("building=temple", t("寺庙", "寺廟", "Temple"));
    m.insert("building=cathedral", t("大教堂", "大教堂", "Cathedral"));
    m.insert("building=greenhouse", t("温室", "溫室", "Greenhouse"));
    m.insert("building=barn", t("谷仓", "穀倉", "Barn"));
    m.insert("building=boathouse", t("船屋", "船屋", "Boathouse"));
    m.insert("building=hangar", t("机库", "機庫", "Hangar"));
    m.insert("building=cabin", t("小木屋", "小木屋", "Cabin"));
    m.insert("building=hut", t("小屋", "小屋", "Hut"));
    m.insert(
        "building=farm_auxiliary",
        t("农用附属建筑", "農用附屬建築", "Farm Auxiliary"),
    );
    m.insert("building=roof", t("屋顶", "屋頂", "Roof"));
    m.insert(
        "building=construction",
        t("在建建筑", "在建建築", "Building Under Construction"),
    );
    m.insert(
        "building=ruins",
        t("废墟建筑", "廢墟建築", "Ruined Building"),
    );
    m.insert(
        "building=train_station",
        t("火车站", "火車站", "Train Station"),
    );
    m.insert(
        "building=transportation",
        t("交通建筑", "交通建築", "Transportation Building"),
    );
    m.insert(
        "building=public",
        t("公共建筑", "公共建築", "Public Building"),
    );
    m.insert(
        "building=civic",
        t("市政建筑", "市政建築", "Civic Building"),
    );
    m.insert(
        "building=service",
        t("服务建筑", "服務建築", "Service Building"),
    );
    m.insert(
        "building=static_caravan",
        t("固定房车", "固定房車", "Static Caravan"),
    );

    // ── highway ────────────────────────────────────────────────────
    m.insert("highway=motorway", t("高速公路", "高速公路", "Motorway"));
    m.insert("highway=trunk", t("干线公路", "幹線公路", "Trunk Road"));
    m.insert("highway=primary", t("主要道路", "主要道路", "Primary Road"));
    m.insert(
        "highway=secondary",
        t("次要道路", "次要道路", "Secondary Road"),
    );
    m.insert(
        "highway=tertiary",
        t("三级道路", "三級道路", "Tertiary Road"),
    );
    m.insert(
        "highway=unclassified",
        t("未分类道路", "未分類道路", "Unclassified Road"),
    );
    m.insert(
        "highway=residential",
        t("居住区道路", "居住區道路", "Residential Road"),
    );
    m.insert("highway=service", t("服务道路", "服務道路", "Service Road"));
    m.insert("highway=track", t("土路/野道", "土路/野道", "Track"));
    m.insert("highway=path", t("小路", "小路", "Path"));
    m.insert("highway=footway", t("人行道", "人行道", "Footway"));
    m.insert("highway=cycleway", t("自行车道", "自行車道", "Cycleway"));
    m.insert(
        "highway=pedestrian",
        t("步行街", "步行街", "Pedestrian Street"),
    );
    m.insert("highway=steps", t("台阶", "臺階", "Steps"));
    m.insert(
        "highway=living_street",
        t("生活街道", "生活街道", "Living Street"),
    );
    m.insert(
        "highway=motorway_link",
        t("高速匝道", "高速匝道", "Motorway Link"),
    );
    m.insert(
        "highway=trunk_link",
        t("干线匝道", "幹線匝道", "Trunk Link"),
    );
    m.insert(
        "highway=primary_link",
        t("主要道路匝道", "主要道路匝道", "Primary Link"),
    );
    m.insert(
        "highway=secondary_link",
        t("次要道路匝道", "次要道路匝道", "Secondary Link"),
    );
    m.insert(
        "highway=tertiary_link",
        t("三级道路匝道", "三級道路匝道", "Tertiary Link"),
    );
    m.insert(
        "highway=construction",
        t("在建道路", "在建道路", "Road Under Construction"),
    );
    m.insert("highway=busway", t("公交专用道", "公車專用道", "Busway"));
    m.insert(
        "highway=bus_guideway",
        t("公交导轨", "公車導軌", "Bus Guideway"),
    );

    // ── landuse ────────────────────────────────────────────────────
    m.insert(
        "landuse=residential",
        t("居住用地", "居住用地", "Residential"),
    );
    m.insert(
        "landuse=commercial",
        t("商业用地", "商業用地", "Commercial"),
    );
    m.insert(
        "landuse=industrial",
        t("工业用地", "工業用地", "Industrial"),
    );
    m.insert("landuse=retail", t("零售用地", "零售用地", "Retail"));
    m.insert(
        "landuse=agricultural",
        t("农业用地", "農業用地", "Agricultural"),
    );
    m.insert("landuse=farmland", t("农田", "農田", "Farmland"));
    m.insert("landuse=farmyard", t("农家院", "農家院", "Farmyard"));
    m.insert("landuse=forest", t("林地", "林地", "Forest"));
    m.insert("landuse=grass", t("草地", "草地", "Grass"));
    m.insert("landuse=meadow", t("草甸", "草甸", "Meadow"));
    m.insert("landuse=park", t("公园", "公園", "Park"));
    m.insert(
        "landuse=recreation_ground",
        t("休闲用地", "休閒用地", "Recreation Ground"),
    );
    m.insert(
        "landuse=village_green",
        t("村落绿地", "村落綠地", "Village Green"),
    );
    m.insert(
        "landuse=greenfield",
        t("待开发绿地", "待開發綠地", "Greenfield"),
    );
    m.insert(
        "landuse=brownfield",
        t("待开发棕地", "待開發棕地", "Brownfield"),
    );
    m.insert(
        "landuse=construction",
        t("施工用地", "施工用地", "Construction Site"),
    );
    m.insert("landuse=quarry", t("采石场", "採石場", "Quarry"));
    m.insert("landuse=landfill", t("填埋场", "填埋場", "Landfill"));
    m.insert("landuse=religious", t("宗教用地", "宗教用地", "Religious"));
    m.insert("landuse=cemetery", t("公墓", "公墓", "Cemetery"));
    m.insert("landuse=education", t("教育用地", "教育用地", "Education"));
    m.insert("landuse=military", t("军事用地", "軍事用地", "Military"));

    // ── natural ────────────────────────────────────────────────────
    m.insert("natural=water", t("水域", "水域", "Water"));
    m.insert("natural=wood", t("树林", "樹林", "Wood"));
    m.insert("natural=tree", t("树木", "樹木", "Tree"));
    m.insert("natural=grassland", t("草原", "草原", "Grassland"));
    m.insert("natural=heath", t("灌丛荒地", "灌叢荒地", "Heath"));
    m.insert("natural=scrub", t("灌木丛", "灌木叢", "Scrub"));
    m.insert("natural=wetland", t("湿地", "濕地", "Wetland"));
    m.insert("natural=beach", t("海滩", "海灘", "Beach"));
    m.insert("natural=bay", t("海湾", "海灣", "Bay"));
    m.insert("natural=cliff", t("悬崖", "懸崖", "Cliff"));
    m.insert("natural=peak", t("山峰", "山峰", "Peak"));
    m.insert("natural=ridge", t("山脊", "山脊", "Ridge"));
    m.insert("natural=valley", t("山谷", "山谷", "Valley"));
    m.insert("natural=reef", t("礁石", "礁石", "Reef"));
    m.insert("natural=glacier", t("冰川", "冰川", "Glacier"));
    m.insert("natural=volcano", t("火山", "火山", "Volcano"));

    // ── shop ───────────────────────────────────────────────────────
    m.insert("shop=supermarket", t("超市", "超市", "Supermarket"));
    m.insert(
        "shop=convenience",
        t("便利店", "便利商店", "Convenience Store"),
    );
    m.insert("shop=bakery", t("面包店", "麵包店", "Bakery"));
    m.insert("shop=butcher", t("肉铺", "肉舖", "Butcher"));
    m.insert("shop=seafood", t("海鲜店", "海鮮店", "Seafood Shop"));
    m.insert("shop=clothes", t("服装店", "服裝店", "Clothing Store"));
    m.insert("shop=fashion", t("时装店", "時裝店", "Fashion Store"));
    m.insert("shop=hairdresser", t("理发店", "理髮店", "Hairdresser"));
    m.insert("shop=beauty", t("美容院", "美容院", "Beauty Salon"));
    m.insert("shop=chemist", t("药店", "藥局", "Chemist"));
    m.insert(
        "shop=electronics",
        t("电子产品店", "電子產品店", "Electronics Store"),
    );
    m.insert("shop=hardware", t("五金店", "五金店", "Hardware Store"));
    m.insert("shop=furniture", t("家具店", "家具店", "Furniture Store"));
    m.insert("shop=books", t("书店", "書店", "Bookstore"));
    m.insert("shop=shoes", t("鞋店", "鞋店", "Shoe Store"));
    m.insert("shop=jewelry", t("珠宝店", "珠寶店", "Jewelry Store"));
    m.insert("shop=gift", t("礼品店", "禮品店", "Gift Shop"));
    m.insert("shop=florist", t("花店", "花店", "Florist"));
    m.insert("shop=greengrocer", t("蔬果店", "蔬果店", "Greengrocer"));
    m.insert("shop=alcohol", t("酒类商店", "酒類商店", "Liquor Store"));
    m.insert("shop=mall", t("购物中心", "購物中心", "Shopping Mall"));
    m.insert(
        "shop=department_store",
        t("百货商场", "百貨商場", "Department Store"),
    );
    m.insert("shop=car", t("汽车销售", "汽車銷售", "Car Dealer"));
    m.insert("shop=bicycle", t("自行车店", "自行車店", "Bicycle Shop"));
    m.insert("shop=sports", t("体育用品店", "體育用品店", "Sports Shop"));
    m.insert("shop=optician", t("眼镜店", "眼鏡店", "Optician"));
    m.insert("shop=pet", t("宠物店", "寵物店", "Pet Shop"));
    m.insert("shop=toys", t("玩具店", "玩具店", "Toy Store"));
    m.insert("shop=stationery", t("文具店", "文具店", "Stationery Shop"));
    m.insert(
        "shop=mobile_phone",
        t("手机店", "手機店", "Mobile Phone Shop"),
    );
    m.insert("shop=computer", t("电脑店", "電腦店", "Computer Shop"));
    m.insert("shop=laundry", t("洗衣店", "洗衣店", "Laundry"));
    m.insert("shop=travel_agency", t("旅行社", "旅行社", "Travel Agency"));
    m.insert("shop=kiosk", t("报刊亭", "報刊亭", "Kiosk"));

    // ── tourism ────────────────────────────────────────────────────
    m.insert("tourism=hotel", t("酒店", "酒店", "Hotel"));
    m.insert("tourism=motel", t("汽车旅馆", "汽車旅館", "Motel"));
    m.insert("tourism=hostel", t("青年旅舍", "青年旅舍", "Hostel"));
    m.insert("tourism=guest_house", t("民宿", "民宿", "Guest House"));
    m.insert(
        "tourism=bed_and_breakfast",
        t("住宿加早餐", "住宿加早餐", "Bed & Breakfast"),
    );
    m.insert(
        "tourism=attraction",
        t("旅游景点", "旅遊景點", "Tourist Attraction"),
    );
    m.insert("tourism=museum", t("博物馆", "博物館", "Museum"));
    m.insert("tourism=gallery", t("画廊", "畫廊", "Art Gallery"));
    m.insert("tourism=viewpoint", t("观景点", "觀景點", "Viewpoint"));
    m.insert(
        "tourism=information",
        t("旅游咨询处", "旅遊諮詢處", "Tourist Information"),
    );
    m.insert("tourism=picnic_site", t("野餐区", "野餐區", "Picnic Site"));
    m.insert("tourism=camp_site", t("露营地", "露營地", "Camp Site"));
    m.insert(
        "tourism=caravan_site",
        t("房车营地", "房車營地", "Caravan Site"),
    );
    m.insert(
        "tourism=theme_park",
        t("主题公园", "主題公園", "Theme Park"),
    );
    m.insert("tourism=zoo", t("动物园", "動物園", "Zoo"));
    m.insert("tourism=aquarium", t("水族馆", "水族館", "Aquarium"));
    m.insert(
        "tourism=alpine_hut",
        t("山间小屋", "山間小屋", "Alpine Hut"),
    );
    m.insert("tourism=chalet", t("度假木屋", "度假木屋", "Chalet"));
    m.insert(
        "tourism=wilderness_hut",
        t("荒野小屋", "荒野小屋", "Wilderness Hut"),
    );

    // ── leisure ────────────────────────────────────────────────────
    m.insert("leisure=park", t("公园", "公園", "Park"));
    m.insert("leisure=garden", t("花园", "花園", "Garden"));
    m.insert("leisure=playground", t("游乐场", "遊樂場", "Playground"));
    m.insert(
        "leisure=sports_centre",
        t("体育中心", "體育中心", "Sports Centre"),
    );
    m.insert("leisure=stadium", t("体育场", "體育場", "Stadium"));
    m.insert("leisure=pitch", t("运动场", "運動場", "Pitch"));
    m.insert(
        "leisure=swimming_pool",
        t("游泳池", "游泳池", "Swimming Pool"),
    );
    m.insert(
        "leisure=fitness_centre",
        t("健身中心", "健身中心", "Fitness Centre"),
    );
    m.insert(
        "leisure=fitness_station",
        t("健身点", "健身點", "Fitness Station"),
    );
    m.insert("leisure=dog_park", t("遛狗公园", "遛狗公園", "Dog Park"));
    m.insert("leisure=ice_rink", t("溜冰场", "溜冰場", "Ice Rink"));
    m.insert("leisure=marina", t("游艇码头", "遊艇碼頭", "Marina"));
    m.insert(
        "leisure=nature_reserve",
        t("自然保护区", "自然保護區", "Nature Reserve"),
    );
    m.insert("leisure=track", t("跑道", "跑道", "Running Track"));
    m.insert(
        "leisure=miniature_golf",
        t("迷你高尔夫", "迷你高爾夫", "Miniature Golf"),
    );
    m.insert(
        "leisure=bowling_alley",
        t("保龄球馆", "保齡球館", "Bowling Alley"),
    );
    m.insert(
        "leisure=escape_game",
        t("密室逃脱", "密室逃脫", "Escape Room"),
    );

    // ── office ─────────────────────────────────────────────────────
    m.insert(
        "office=government",
        t("政府机关", "政府機關", "Government Office"),
    );
    m.insert("office=company", t("公司", "公司", "Company Office"));
    m.insert("office=ngo", t("非政府组织", "非政府組織", "NGO"));
    m.insert(
        "office=coworking",
        t("共享办公", "共享辦公", "Coworking Space"),
    );

    // ── barrier ────────────────────────────────────────────────────
    m.insert("barrier=wall", t("围墙", "圍牆", "Wall"));
    m.insert("barrier=fence", t("栅栏", "柵欄", "Fence"));
    m.insert("barrier=gate", t("大门", "大門", "Gate"));
    m.insert("barrier=hedge", t("树篱", "樹籬", "Hedge"));
    m.insert("barrier=bollard", t("路桩", "路樁", "Bollard"));

    // ── waterway ───────────────────────────────────────────────────
    m.insert("waterway=river", t("河流", "河流", "River"));
    m.insert("waterway=stream", t("溪流", "溪流", "Stream"));
    m.insert("waterway=canal", t("运河", "運河", "Canal"));
    m.insert("waterway=drain", t("排水沟", "排水溝", "Drain"));
    m.insert("waterway=ditch", t("沟渠", "溝渠", "Ditch"));
    m.insert("waterway=fairway", t("航道", "航道", "Fairway"));

    // ── aeroway ────────────────────────────────────────────────────
    m.insert("aeroway=aerodrome", t("机场", "機場", "Airport"));
    m.insert("aeroway=helipad", t("直升机坪", "直昇機坪", "Helipad"));
    m.insert("aeroway=runway", t("跑道", "跑道", "Runway"));

    // ── railway ────────────────────────────────────────────────────
    m.insert("railway=station", t("火车站", "火車站", "Railway Station"));
    m.insert("railway=platform", t("站台", "月臺", "Platform"));
    m.insert(
        "railway=subway_entrance",
        t("地铁入口", "地鐵入口", "Subway Entrance"),
    );
    m.insert(
        "railway=tram_stop",
        t("有轨电车站", "有軌電車站", "Tram Stop"),
    );
    m.insert("railway=halt", t("火车小站", "火車小站", "Railway Halt"));

    // ── place ──────────────────────────────────────────────────────
    m.insert("place=city", t("城市", "城市", "City"));
    m.insert("place=town", t("城镇", "城鎮", "Town"));
    m.insert("place=village", t("村庄", "村莊", "Village"));
    m.insert("place=hamlet", t("小村落", "小村落", "Hamlet"));
    m.insert("place=suburb", t("郊区", "郊區", "Suburb"));
    m.insert("place=neighbourhood", t("街区", "街區", "Neighbourhood"));
    m.insert("place=island", t("岛屿", "島嶼", "Island"));

    m
}

fn t(zh_cn: &'static str, zh_tw: &'static str, en: &'static str) -> PresetTranslation {
    PresetTranslation { zh_cn, zh_tw, en }
}
