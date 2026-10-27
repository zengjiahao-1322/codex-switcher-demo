//! Official accounts: prototype summary only; JSON-RPC/login/quota pending batch 3.
use serde_json::Value;
pub fn claims(token: &str) -> Value {
    let Some(payload) = token.split('.').nth(1) else {
        return Value::Null;
    };
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut out = Vec::new();
    for c in payload.bytes() {
        let n = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return Value::Null,
        };
        acc = (acc << 6) | u32::from(n);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    serde_json::from_slice(&out).unwrap_or(Value::Null)
}
