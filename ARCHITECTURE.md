# System Architecture Diagram

```mermaid
  flowchart LR
    A[User Sync Client] --> B[Nginx Reverse Proxy]
    B --> C[App Server]
    C --> D[Database]
```