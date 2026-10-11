//! WebAssembly bindings used by the Kindlemom web app.
//!
//! Thin layer over boko: conversion, metadata inspection and cover
//! extraction, all running in the browser.

use std::io::Cursor;

use boko::{Book, Format};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

fn parse_format(name: &str) -> Result<Format, JsValue> {
    match name.to_ascii_lowercase().as_str() {
        "epub" => Ok(Format::Epub),
        "azw3" => Ok(Format::Azw3),
        "mobi" | "azw" | "prc" => Ok(Format::Mobi),
        "kfx" => Ok(Format::Kfx),
        _ => Err(JsValue::from_str(&format!("format inconnu : {name}"))),
    }
}

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn open(data: &[u8], from: &str) -> Result<Book, JsValue> {
    Book::from_bytes(data, parse_format(from)?).map_err(js_err)
}

/// Convert raw ebook bytes from one format to another.
#[wasm_bindgen]
pub fn convert(data: &[u8], from: &str, to: &str) -> Result<Vec<u8>, JsValue> {
    let book = open(data, from)?;
    let mut out = Cursor::new(Vec::new());
    book.export(parse_format(to)?, &mut out).map_err(js_err)?;
    Ok(out.into_inner())
}

#[derive(Serialize)]
struct Info<'a> {
    title: &'a str,
    authors: &'a [String],
    language: &'a str,
    identifier: &'a str,
    has_cover: bool,
    /// Id a boko-made KFX gets for this book; the Kindle keys sideloaded
    /// library thumbnails on it.
    kfx_content_id: String,
}

/// Book metadata as a JSON string.
#[wasm_bindgen]
pub fn inspect(data: &[u8], from: &str) -> Result<String, JsValue> {
    let book = open(data, from)?;
    let meta = book.metadata();
    // Mirrors boko's KFX exporter seed (export/kfx/metadata_frags.rs).
    let seed = if meta.identifier.is_empty() {
        format!("{}\n{}", meta.title, meta.authors.join("&"))
    } else {
        meta.identifier.clone()
    };
    let info = Info {
        title: &meta.title,
        authors: &meta.authors,
        language: &meta.language,
        identifier: &meta.identifier,
        has_cover: meta.cover_image.is_some(),
        kfx_content_id: boko::kfx::metadata::generate_content_id(&seed),
    };
    serde_json::to_string(&info).map_err(js_err)
}

/// Cover image bytes, or an empty array when the book has none.
#[wasm_bindgen]
pub fn cover(data: &[u8], from: &str) -> Result<Vec<u8>, JsValue> {
    let book = open(data, from)?;
    match book.metadata().cover_image.clone() {
        Some(path) => Ok(book.load_asset(&path).unwrap_or_default()),
        None => Ok(Vec::new()),
    }
}
