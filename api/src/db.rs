//! Thin D1 helpers. All values are bound parameters; SQL text never contains user input.

use serde::de::DeserializeOwned;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement};

use crate::error::{ApiError, ApiResult};

pub enum Arg {
    Null,
    Text(String),
    Int(i64),
    Blob(Vec<u8>),
}

impl From<&str> for Arg {
    fn from(s: &str) -> Self {
        Arg::Text(s.to_string())
    }
}
impl From<String> for Arg {
    fn from(s: String) -> Self {
        Arg::Text(s)
    }
}
impl From<&String> for Arg {
    fn from(s: &String) -> Self {
        Arg::Text(s.clone())
    }
}
impl From<i64> for Arg {
    fn from(i: i64) -> Self {
        Arg::Int(i)
    }
}
impl<T: Into<Arg>> From<Option<T>> for Arg {
    fn from(o: Option<T>) -> Self {
        o.map(Into::into).unwrap_or(Arg::Null)
    }
}

fn to_js(a: &Arg) -> JsValue {
    match a {
        Arg::Null => JsValue::NULL,
        Arg::Text(s) => JsValue::from_str(s),
        Arg::Int(i) => JsValue::from_f64(*i as f64),
        Arg::Blob(b) => worker::js_sys::Uint8Array::from(&b[..]).into(),
    }
}

#[macro_export]
macro_rules! args {
    ($($x:expr),* $(,)?) => { vec![$($crate::db::Arg::from($x)),*] };
}

pub fn stmt(db: &D1Database, sql: &str, args: Vec<Arg>) -> ApiResult<D1PreparedStatement> {
    let js: Vec<JsValue> = args.iter().map(to_js).collect();
    Ok(db.prepare(sql).bind(&js)?)
}

pub async fn all<T: DeserializeOwned>(db: &D1Database, sql: &str, args: Vec<Arg>) -> ApiResult<Vec<T>> {
    Ok(stmt(db, sql, args)?.all().await?.results::<T>()?)
}

pub async fn first<T: DeserializeOwned>(db: &D1Database, sql: &str, args: Vec<Arg>) -> ApiResult<Option<T>> {
    Ok(all::<T>(db, sql, args).await?.into_iter().next())
}

/// Execute and return the number of changed rows.
pub async fn run(db: &D1Database, sql: &str, args: Vec<Arg>) -> ApiResult<usize> {
    let r = stmt(db, sql, args)?.run().await?;
    Ok(r.meta()?.and_then(|m| m.changes).unwrap_or(0))
}

pub async fn batch(db: &D1Database, stmts: Vec<D1PreparedStatement>) -> ApiResult<()> {
    db.batch(stmts).await?;
    Ok(())
}

/// D1 reports constraint failures as errors whose text names the constraint.
pub fn is_unique_violation(e: &worker::Error) -> bool {
    e.to_string().contains("UNIQUE constraint failed")
}

pub async fn run_unique(db: &D1Database, sql: &str, args: Vec<Arg>) -> Result<usize, Option<ApiError>> {
    let s = stmt(db, sql, args).map_err(Some)?;
    match s.run().await {
        Ok(r) => Ok(r.meta().ok().flatten().and_then(|m| m.changes).unwrap_or(0)),
        Err(e) if is_unique_violation(&e) => Err(None),
        Err(e) => Err(Some(e.into())),
    }
}

#[derive(serde::Deserialize)]
pub struct Count {
    pub n: i64,
}
