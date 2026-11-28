"""Core memory module package for Alfred v2."""

from __future__ import annotations

from .engine import (
    MemoryDeleteResponse,
    MemoryEngine,
    MemoryListResponse,
    MemoryNamespaceError,
    MemoryNotFoundError,
    MemoryRecord,
    MemorySaveInput,
    MemoryUpdateInput,
    MemoryUseRecord,
    MemoryVersionRecord,
    MemoryVersionsResponse,
    sanitize_fts5_query,
)
from .migrations import CORE_MEMORY_MIGRATIONS, CORE_MEMORY_SCHEMA_SQL
from .plugin import CoreMemoryPlugin, plugin

__all__ = [
    "CORE_MEMORY_MIGRATIONS",
    "CORE_MEMORY_SCHEMA_SQL",
    "CoreMemoryPlugin",
    "MemoryDeleteResponse",
    "MemoryEngine",
    "MemoryListResponse",
    "MemoryNamespaceError",
    "MemoryNotFoundError",
    "MemoryRecord",
    "MemorySaveInput",
    "MemoryUpdateInput",
    "MemoryUseRecord",
    "MemoryVersionRecord",
    "MemoryVersionsResponse",
    "plugin",
    "sanitize_fts5_query",
]
