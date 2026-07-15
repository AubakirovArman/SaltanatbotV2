# HTTP safety primitives

Shared helpers in this folder enforce transport-level limits before a complete upstream response is
allocated. Market adapters should use `readBoundedText` instead of `Response.text()`/`json()` when
payload size is part of their trust boundary. The helper counts streamed bytes, cancels the body on
overflow and also rejects an oversized declared `Content-Length`.
