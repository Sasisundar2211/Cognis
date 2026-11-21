//! Embeddings. Production: Workers AI bge-small-en-v1.5 (384 dims, same model family as FastEmbed's default).
//! Tests: a deterministic trigram-hash double with no semantic understanding.

pub const DIM: usize = 384;
pub const BGE_MODEL: &str = "@cf/baai/bge-small-en-v1.5";

pub enum Embedder {
    #[cfg(target_arch = "wasm32")]
    WorkersAi(worker::Ai),
    TestHash,
}

impl Embedder {
    pub fn model(&self) -> &'static str {
        match self {
            #[cfg(target_arch = "wasm32")]
            Embedder::WorkersAi(_) => BGE_MODEL,
            Embedder::TestHash => "test-hash-trigram",
        }
    }

    /// Cosine floor below which a hit counts as unrelated. 0.45 for bge is a starting value, not yet calibrated.
    pub fn min_similarity(&self) -> f32 {
        match self {
            #[cfg(target_arch = "wasm32")]
            Embedder::WorkersAi(_) => 0.45,
            Embedder::TestHash => 0.1,
        }
    }

    pub async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, ()> {
        match self {
            #[cfg(target_arch = "wasm32")]
            Embedder::WorkersAi(ai) => {
                #[derive(serde::Deserialize)]
                struct Out {
                    data: Vec<Vec<f32>>,
                }
                let out: Out = ai.run(BGE_MODEL, serde_json::json!({ "text": texts })).await.map_err(|_| ())?;
                if out.data.len() != texts.len() {
                    return Err(());
                }
                Ok(out.data.into_iter().map(normalize).collect())
            }
            Embedder::TestHash => Ok(texts.iter().map(|t| hash_embed(t)).collect()),
        }
    }
}

pub fn hash_embed(t: &str) -> Vec<f32> {
    let mut v = vec![0f32; DIM];
    let cleaned: String = t.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
    let s: Vec<u16> = format!(" {cleaned} ").encode_utf16().collect();
    for w in s.windows(3) {
        let mut h: u32 = 2_166_136_261;
        for &c in w {
            h = (h ^ c as u32).wrapping_mul(16_777_619);
        }
        v[(h as usize) % DIM] += 1.0;
    }
    normalize(v)
}

pub fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn from_blob(b: &[u8]) -> Option<Vec<f32>> {
    (b.len() % 4 == 0 && !b.is_empty()).then(|| b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

/// Text sent to the embedder for an item. Capped to stay within the model's 512-token window.
pub fn embedding_text(title: &str, description: &str, content: &str, extracted: &str) -> String {
    [title, description, content, extracted].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n").chars().take(2000).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_roundtrip_and_cosine() {
        let v = normalize(vec![3.0, 4.0]);
        assert_eq!(from_blob(&to_blob(&v)).unwrap(), v);
        assert!((dot(&v, &v) - 1.0).abs() < 1e-6);
        assert!(from_blob(&[1, 2, 3]).is_none());
        let a = hash_embed("reddit marketing");
        assert!(dot(&a, &hash_embed("reddit marketing strategy")) > dot(&a, &hash_embed("banana bread")));
    }
}
