use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use log::{error, info};

use crate::ai::AiRouter;
use crate::cache::SmartCache;
use crate::config::ProxyConfig;
use crate::proxy::OsmProxy;
use crate::translate::Translator;

mod ai;
mod cache;
mod config;
mod kimi;
mod photos;
mod providers;
mod proxy;
mod rules;
mod split;
mod translate;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::init();

    let config = ProxyConfig::load();
    info!("Initializing OSM proxy");
    info!("  Listen address: {}", config.listen_addr);
    info!("  Upstream URL: {}", config.upstream_url);
    info!("  Tile upstream URL: {}", config.tile_upstream_url);
    info!("  iD static directory: {}", config.id_static_dir);

    let cache_dir = config.cache_dir.as_ref().map(PathBuf::from);
    let cache = Arc::new(SmartCache::with_cache_dir(
        config.cache_max_size,
        Duration::from_secs(config.cache_default_ttl),
        cache_dir,
    ));

    let translator = config.bing_translate_api_key.as_ref().map(|key| {
        info!("Bing Translate API configured");
        Translator::new(key.clone(), config.bing_translate_region.clone())
    });
    let ai_router = AiRouter::from_config(&config);
    if ai_router.text_configured() || ai_router.search_configured() || ai_router.visual_configured()
    {
        info!("One or more AI providers are configured");
    }

    let proxy = OsmProxy::new(
        cache.clone(),
        translator,
        ai_router,
        config.upstream_url.clone(),
        config.tile_upstream_url.clone(),
        PathBuf::from(&config.id_static_dir),
        config.osm_oauth_client_id.clone(),
        config.osm_oauth_redirect_uri.clone(),
        PathBuf::from(&config.photo_upload_dir),
        config.trusted_proxy_ips.clone(),
        config.proxy_all_tiles,
    );

    let cache_for_stats = cache.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            let (hits, misses, size) = cache_for_stats.get_stats().await;
            let total = hits + misses;
            let hit_rate = if total > 0 {
                hits as f64 / total as f64 * 100.0
            } else {
                0.0
            };
            info!(
                "Cache stats - hits: {}, misses: {}, size: {}, hit rate: {:.2}%",
                hits, misses, size, hit_rate
            );
        }
    });

    if let Err(err) = proxy.run(config).await {
        error!("Server error: {}", err);
    }
    Ok(())
}
