//! Claude Code access policy for local and SSH clients.
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Direct,
    Adapter,
    Unavailable(&'static str),
}
impl Access {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Adapter => "adapter",
            Self::Unavailable(_) => "unavailable",
        }
    }
    pub(super) fn reason(self) -> Option<&'static str> {
        match self {
            Self::Unavailable(reason) => Some(reason),
            _ => None,
        }
    }
}
pub fn local(provider: &Value) -> Access {
    let base = provider["baseUrl"].as_str().unwrap_or("");
    let host = base
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    let local = host == "localhost"
        || host.starts_with("localhost:")
        || host == "127.0.0.1"
        || host.starts_with("127.0.0.1:")
        || host.starts_with("[::1]");
    if !local && provider["apiKey"].as_str().is_none_or(str::is_empty) {
        Access::Unavailable("缺少密钥")
    } else if provider["apiMode"] == "anthropic_messages" {
        Access::Direct
    } else {
        Access::Adapter
    }
}
pub fn remote(provider: &Value) -> Access {
    match local(provider) {
        Access::Adapter => Access::Unavailable("远程只能用 Anthropic 协议的 API"),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn protocol_key_and_location_matrix() {
        for mode in ["anthropic_messages", "responses", "chat_completions"] {
            for base in [
                "https://fixture.invalid/v1",
                "http://127.0.0.1:1234/v1",
                "http://localhost:1234/v1",
                "http://[::1]:1234/v1",
            ] {
                for key in ["fixture-key", ""] {
                    let provider = json!({"apiMode":mode,"baseUrl":base,"apiKey":key});
                    let has_key = !key.is_empty() || base.starts_with("http://");
                    let expected = if !has_key {
                        Access::Unavailable("缺少密钥")
                    } else if mode == "anthropic_messages" {
                        Access::Direct
                    } else {
                        Access::Adapter
                    };
                    assert_eq!(local(&provider), expected, "{mode} {base} {key}");
                    let expected_remote = if !has_key {
                        Access::Unavailable("缺少密钥")
                    } else if mode == "anthropic_messages" {
                        Access::Direct
                    } else {
                        Access::Unavailable("远程只能用 Anthropic 协议的 API")
                    };
                    assert_eq!(remote(&provider), expected_remote, "{mode} {base} {key}");
                }
            }
        }
    }
}
