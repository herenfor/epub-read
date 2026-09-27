//! Android 常规 invoke 在 Tauri 2.11.5 下走 postMessage，会把嵌套的
//! `Uint8Array` 转成 JSON 顶层数字数组。这里只做最薄的请求字节解码：
//! Raw 在所有平台保持借用；只有 Android 接受严格的顶层 JSON byte array。
//! 其他平台仍只接受 Raw，避免把平台兼容扩散到 Windows/测试构建。

use std::borrow::Cow;

use tauri::ipc::InvokeBody;

#[cfg(any(target_os = "android", test))]
use serde_json::Value;

#[cfg(any(target_os = "android", test))]
fn decode_android_byte_array(values: &[Value]) -> Result<Vec<u8>, &'static str> {
    values
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|number| u8::try_from(number).ok())
                .ok_or("Android 字节请求含非法值")
        })
        .collect()
}

#[cfg(any(target_os = "android", test))]
fn decode_android_json(value: &Value, max_bytes: Option<usize>) -> Result<Vec<u8>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| "Android 字节请求必须是 JSON 数组".to_string())?;
    if max_bytes.is_some_and(|limit| values.len() > limit) {
        return Err("Android 字节请求超过大小上限".to_string());
    }
    decode_android_byte_array(values).map_err(str::to_string)
}

/// 把 Tauri invoke body 解成请求字节。
///
/// Raw 分支返回 `Cow::Borrowed`，所有平台不复制原请求数据；非法 JSON
/// 数组整体失败，调用方不得在失败前写文件或索引。`max_bytes` 仅在 Android
/// JSON 路径下用于分配 Vec 之前检查长度，Raw 的现有命令级上限保持不变。
pub(crate) fn decode_request_bytes<'a>(
    body: &'a InvokeBody,
    max_bytes: Option<usize>,
    raw_only_error: &'static str,
) -> Result<Cow<'a, [u8]>, String> {
    #[cfg(target_os = "android")]
    let _ = raw_only_error;

    match body {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes.as_slice())),
        InvokeBody::Json(value) => {
            #[cfg(target_os = "android")]
            {
                decode_android_json(value, max_bytes).map(Cow::Owned)
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (value, max_bytes);
                Err(raw_only_error.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn raw_bytes_are_borrowed_unchanged() {
        let body = InvokeBody::Raw(vec![0, 128, 255]);
        let decoded = decode_request_bytes(&body, None, "only raw").unwrap();
        assert!(matches!(decoded, Cow::Borrowed(_)));
        assert_eq!(decoded.as_ref(), &[0, 128, 255]);
    }

    #[test]
    fn non_android_json_body_is_rejected() {
        let body = InvokeBody::Json(json!([1, 2, 3]));
        assert_eq!(
            decode_request_bytes(&body, None, "only raw").unwrap_err(),
            "only raw"
        );
    }

    #[test]
    fn android_byte_array_accepts_boundary_values() {
        let decoded = decode_android_json(&json!([0, 128, 255]), None).unwrap();
        assert_eq!(decoded, vec![0, 128, 255]);
        assert_eq!(
            decode_android_json(&json!([]), None).unwrap(),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn android_byte_array_rejects_any_invalid_element_as_a_whole() {
        for invalid in [
            json!([1, -1, 3]),
            json!([1, 256, 3]),
            json!([1, 1.5, 3]),
            json!([1, true, 3]),
            json!([1, null, 3]),
            json!([1, "2", 3]),
            json!([1, [2], 3]),
        ] {
            assert!(decode_android_json(&invalid, None).is_err());
        }
        assert!(decode_android_json(&json!({"bytes": [1, 2]}), None).is_err());
    }

    #[test]
    fn android_byte_array_checks_limit_before_decode() {
        assert!(decode_android_json(&json!([1, 2, 3]), Some(2)).is_err());
        assert_eq!(
            decode_android_json(&json!([1, 2]), Some(2)).unwrap(),
            vec![1, 2]
        );
    }
}
