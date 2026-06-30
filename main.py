# Make Python's TLS use the OS trust store (Windows/macOS), so HTTPS to LLM /
# stock-footage APIs works behind TLS-intercepting AV/proxies (e.g. Avast),
# whose root CA lives in the OS store but not in certifi.
# ponytail: try/except so machines without truststore still run.
try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

import uvicorn
from loguru import logger

from app.config import config

if __name__ == "__main__":
    logger.info(
        "start server, docs: http://127.0.0.1:" + str(config.listen_port) + "/docs"
    )
    uvicorn.run(
        app="app.asgi:app",
        host=config.listen_host,
        port=config.listen_port,
        reload=config.reload_debug,
        log_level="warning",
    )
