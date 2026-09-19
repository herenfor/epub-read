//! C-58B real-model probe, ignored by default.
//!
//! Internal module so the probe can drive the real store, model read lock and
//! DirectML session without widening the crate's public API.  Nothing is
//! downloaded: the package must already exist below the model root with its
//! real `model.json`.
//!
//! Run on Windows:
//!
//! ```powershell
//! $env:C58B_MODEL_ROOT='D:\EpubModels'
//! $env:C58B_PACKAGE_DIR='bge-small-zh-v1.5'
//! cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features `
//!   --features ai ai::c58b_probe_tests -- --ignored --nocapture
//! ```
use std::path::PathBuf;

use super::embedding::{self, new_session_owner, DeviceReport, PreparedModel, Purpose};
use super::embedding_platform;
use super::model_locks::ModelLock;
use super::{semantic_store, AiStore};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn package_root() -> (PathBuf, String) {
    let root = env("C58B_MODEL_ROOT").unwrap_or_else(|| "D:\\EpubModels".to_string());
    let dir = env("C58B_PACKAGE_DIR").unwrap_or_else(|| "bge-small-zh-v1.5".to_string());
    (PathBuf::from(root), dir)
}

/// Reads the real `model.json` and hashes the same file groups the production
/// resolver hashes: model plus external data vs every tokenizer file.
fn prepared_model() -> PreparedModel {
    let (root, package_dir) = package_root();
    let package_path = root.join(&package_dir);
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(package_path.join("model.json")).expect("model.json readable"),
    )
    .expect("model.json parses");
    let files: Vec<String> = manifest["files"]
        .as_array()
        .expect("files array")
        .iter()
        .map(|file| {
            file["relativePath"]
                .as_str()
                .expect("relativePath")
                .to_string()
        })
        .collect();
    let pick = |predicate: fn(&str) -> bool| -> Vec<(String, PathBuf)> {
        files
            .iter()
            .filter(|name| predicate(name))
            .map(|name| (name.clone(), package_path.join(name)))
            .collect()
    };
    let model_files = pick(|name| {
        let lower = name.to_ascii_lowercase();
        lower.ends_with(".onnx") || lower.ends_with(".onnx_data")
    });
    let tokenizer_files = pick(|name| {
        let lower = name.to_ascii_lowercase();
        lower.contains("tokenizer") || lower.ends_with("vocab.txt")
    });
    let model_path = model_files
        .iter()
        .find(|(name, _)| name.to_ascii_lowercase().ends_with(".onnx"))
        .expect("model.onnx present")
        .1
        .clone();
    let tokenizer_path = tokenizer_files
        .iter()
        .find(|(name, _)| name.to_ascii_lowercase().ends_with("tokenizer.json"))
        .expect("tokenizer.json present")
        .1
        .clone();
    PreparedModel {
        package_id: manifest["packageId"]
            .as_str()
            .unwrap_or("bge-small-zh-v1.5")
            .to_string(),
        package_dir: package_dir.clone(),
        root,
        model_path,
        tokenizer_path,
        model_digest: digest_group(&model_files),
        tokenizer_digest: digest_group(&tokenizer_files),
        dimensions: manifest["dimensions"].as_u64().unwrap_or(512) as usize,
        max_tokens: manifest["maxInput"].as_u64().unwrap_or(512) as usize,
        pooling: "cls".to_string(),
        query_prefix: embedding::DEFAULT_QUERY_PREFIX.to_string(),
        passage_prefix: String::new(),
    }
}

fn digest_group(files: &[(String, PathBuf)]) -> String {
    use sha2::{Digest, Sha256};
    let mut sorted = files.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (relative, path) in sorted {
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(std::fs::read(path).expect("asset readable"));
    }
    format!("{:x}", hasher.finalize())
}

/// Opens one real session through the same admission and read-lock path the
/// application uses.
fn open_real_session(model: &PreparedModel) -> embedding::SessionOwner {
    assert_eq!(
        embedding_platform::PLATFORM_IMPLEMENTATION,
        "windows-directml",
        "the Windows DirectML runtime was not linked into this build"
    );
    let guard = ModelLock::assets(&model.root, &model.package_dir, &model.package_id)
        .expect("model read lock");
    let (tokenizer, runtime, device) =
        embedding_platform::create(model, env("C58B_DEVICE_LUID").as_deref()).unwrap_or_else(
            |error| {
                panic!(
                    "DirectML runtime init failed: {} {}",
                    error.kind as u8, error.message
                )
            },
        );
    let profile = embedding::describe(model, &runtime.version()).expect("profile");
    new_session_owner(
        "probe-session".to_string(),
        profile,
        tokenizer,
        runtime,
        device,
        guard,
    )
    .expect("session admission")
}

fn vector_digest(vector: &[f64]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for value in vector {
        hasher.update((*value as f32).to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[test]
#[ignore = "requires a local verified model package and a DirectML device"]
fn real_model_probe_reports_identity_and_vector_statistics() {
    let model = prepared_model();
    let mut owner = open_real_session(&model);
    let text = env("C58B_PROBE_TEXT")
        .unwrap_or_else(|| "本地语义检索探针：这句话用于验证真实模型输出。".to_string());
    let started = std::time::Instant::now();
    let query = owner
        .session
        .embed(&[text.clone()], Purpose::Query)
        .unwrap_or_else(|error| {
            panic!("query embed failed: {} {}", error.kind as u8, error.message)
        });
    let passage = owner
        .session
        .embed(&[text.clone()], Purpose::Passage)
        .unwrap_or_else(|error| {
            panic!(
                "passage embed failed: {} {}",
                error.kind as u8, error.message
            )
        });
    let elapsed_ms = started.elapsed().as_millis();
    let profile = owner.session.profile.clone();
    let device: DeviceReport = owner.session.device().clone();
    owner.dispose().expect("session disposal");
    let vector = &query[0];
    let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
    let max_abs = vector.iter().fold(0f64, |acc, value| acc.max(value.abs()));
    let cosine = vector
        .iter()
        .zip(passage[0].iter())
        .map(|(a, b)| a * b)
        .sum::<f64>();
    let report = serde_json::json!({
        "platformImplementation": embedding_platform::PLATFORM_IMPLEMENTATION,
        "modelId": profile.model_id,
        "runtimeVersion": profile.runtime_version,
        "dimensions": profile.dimensions,
        "maxTokens": profile.max_tokens,
        "queryPrefix": profile.query_prefix,
        "device": device,
        "vectorPreview": vector.iter().take(8).collect::<Vec<_>>(),
        "vectorNorm": norm,
        "vectorMaxAbs": max_abs,
        "vectorDigest": vector_digest(vector),
        "queryPassageCosine": cosine,
        "elapsedMs": elapsed_ms,
        "text": text,
    });
    println!("C58B_PROBE_REPORT {report}");
    assert_eq!(vector.len(), profile.dimensions);
    assert!((norm - 1.0).abs() < 1e-6, "vector must be L2 normalized");
    assert!(max_abs > 0.0 && max_abs.is_finite());
}

#[test]
#[ignore = "requires a local verified model package and a DirectML device"]
fn real_model_pipeline_builds_and_queries_one_book() {
    use semantic_store::{BatchPolicy, EmbeddingProfile, Request, SemanticManifest, SemanticRow};

    let model = prepared_model();
    let mut owner = open_real_session(&model);
    let described = owner.session.profile.clone();
    let texts = [
        "量子纠缠是量子力学中的一种非经典关联。",
        "地壳板块运动是地震的主要成因之一。",
        "光合作用把光能转化为化学能。",
    ];
    let vectors = owner
        .session
        .embed(&texts.map(str::to_string), Purpose::Passage)
        .expect("passage vectors");
    let app_data = std::env::temp_dir().join(format!("c58b-pipeline-{}", std::process::id()));
    let store = AiStore::open(&app_data).expect("store");
    let manifest = SemanticManifest {
        component_version: 1,
        book_fingerprint: "a".repeat(64),
        parser_version: "parser-v1".into(),
        normalizer_version: "normalizer-v1".into(),
        chunker_version: "chunker-v1".into(),
        profile: EmbeddingProfile {
            model_id: described.model_id.clone(),
            model_digest: described.model_digest.clone(),
            tokenizer_digest: described.tokenizer_digest.clone(),
            runtime_version: described.runtime_version.clone(),
            dimensions: described.dimensions,
            max_tokens: described.max_tokens,
            pooling: described.pooling.clone(),
            normalization: described.normalization.clone(),
            query_prefix: described.query_prefix.clone(),
            passage_prefix: described.passage_prefix.clone(),
        },
    };
    let rows: Vec<SemanticRow> = texts
        .iter()
        .enumerate()
        .map(|(index, text)| SemanticRow {
            ordinal: index as i64,
            chunk: serde_json::json!({
                "bookFingerprint": manifest.book_fingerprint,
                "chunkId": format!("chunk-{index}"),
                "chapterPath": "book/chapter.xhtml",
                "chapterTitle": "测试章",
                "spineIndex": 0,
                "contentType": "body",
                "originalText": text,
                "normalizedText": text,
                "textAnchor": {
                    "start": index * 10,
                    "end": index * 10 + text.chars().count(),
                    "snippet": text.chars().take(12).collect::<String>(),
                },
                "parserVersion": "parser-v1",
                "normalizerVersion": "normalizer-v1",
                "chunkerVersion": "chunker-v1",
            }),
            vector: vectors[index].clone(),
        })
        .collect();
    store
        .semantic(Request::Begin {
            manifest: manifest.clone(),
            manifest_key: "e".repeat(64),
            owner: "probe-owner-1".into(),
            corpus_digest: "f".repeat(64),
            policy: BatchPolicy {
                max_rows: 32,
                max_tokens: described.max_tokens.min(480),
                max_bytes: 512 * 1024,
            },
            force: true,
        })
        .expect("begin");
    store
        .semantic(Request::Append {
            book: manifest.book_fingerprint.clone(),
            owner: "probe-owner-1".into(),
            sequence: 0,
            rows,
        })
        .expect("append");
    store
        .semantic(Request::Commit {
            book: manifest.book_fingerprint.clone(),
            owner: "probe-owner-1".into(),
            batches: 1,
            total: 3,
        })
        .expect("commit");
    let query = owner
        .session
        .embed(&["地震是怎么发生的？".to_string()], Purpose::Query)
        .expect("query vector");
    let opened = store
        .semantic(Request::OpenSnapshot {
            book: manifest.book_fingerprint.clone(),
        })
        .expect("snapshot");
    let generation = opened.snapshot.as_ref().expect("snapshot page").generation;
    let page = store
        .semantic(Request::ReadSnapshot {
            book: manifest.book_fingerprint.clone(),
            generation,
            after: 0,
            limit: 32,
        })
        .expect("read");
    let mut scored: Vec<(f64, String)> = page
        .snapshot
        .expect("page")
        .rows
        .iter()
        .map(|row| {
            let text = row.chunk["originalText"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let score = query[0]
                .iter()
                .zip(row.vector.iter())
                .map(|(a, b)| a * b)
                .sum::<f64>();
            (score, text)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    store
        .semantic(Request::CloseSnapshot {
            book: manifest.book_fingerprint.clone(),
            generation,
        })
        .expect("close snapshot");
    // Cleanup path: the real store must delete the published generation and
    // refuse nothing at this point, which is what the UI button depends on.
    let before = store
        .semantic(Request::Status {
            book: manifest.book_fingerprint.clone(),
        })
        .expect("status before clear");
    assert_eq!(
        before.generations.len(),
        1,
        "one published generation expected"
    );
    let cleared = store
        .semantic(Request::Clear {
            book: manifest.book_fingerprint.clone(),
            owner: "probe-cleanup-1".into(),
        })
        .expect("clear");
    let after = store
        .semantic(Request::Status {
            book: manifest.book_fingerprint.clone(),
        })
        .expect("status after clear");
    assert!(
        after.published.is_none(),
        "clear must remove the generation"
    );
    assert!(after.job.is_none(), "clear must remove the job");
    assert!(
        after.generations.is_empty(),
        "clear must leave no generations"
    );
    println!(
        "C58B_PIPELINE_REPORT {}",
        serde_json::json!({
            "generation": generation,
            "rows": scored.len(),
            "ranking": scored,
            "runtimeVersion": described.runtime_version,
            "cleanup": {
                "generationsBefore": before.generations.len(),
                "generationsAfter": after.generations.len(),
                "publishedAfter": cleared.published.is_some(),
            },
        })
    );
    owner.dispose().expect("session close");
    assert_eq!(generation, 1);
    let _ = std::fs::remove_dir_all(&app_data);
}
