"""Alfred `core-cli` built-in module package."""

from __future__ import annotations

from .cli_manager import (
    CliProfilesResponse,
    CliProfileSummary,
    CliProviderStatus,
    CliStatusReport,
    CliSwitchResult,
    CoreCliService,
    McpSkillSyncResult,
)
from .cli_runner import (
    AgyCliProvider,
    BaseCliModelProvider,
    ClaudeCliProvider,
    CliExecutionError,
    CliSubprocessRequest,
    CliSubprocessResult,
    CliSubprocessRunner,
    CodexCliProvider,
    GeminiCliProvider,
)
from .plugin import CoreCliPlugin, plugin
from .profiles import (
    EXPLICIT_SANITIZE_ENV_KEYS,
    SUPPORTED_CLI_PROVIDERS,
    CliProviderId,
    CliRuntimeTracker,
    ProfileManager,
    build_sanitized_env,
)
from .tools import (
    BashArgs,
    FsReadArgs,
    FsWriteArgs,
    GitArgs,
    build_core_cli_tools,
)

__all__ = [
    "AgyCliProvider",
    "BaseCliModelProvider",
    "BashArgs",
    "ClaudeCliProvider",
    "CliExecutionError",
    "CliProfileSummary",
    "CliProfilesResponse",
    "CliProviderId",
    "CliProviderStatus",
    "CliRuntimeTracker",
    "CliStatusReport",
    "CliSubprocessRequest",
    "CliSubprocessResult",
    "CliSubprocessRunner",
    "CliSwitchResult",
    "CodexCliProvider",
    "CoreCliPlugin",
    "CoreCliService",
    "EXPLICIT_SANITIZE_ENV_KEYS",
    "FsReadArgs",
    "FsWriteArgs",
    "GeminiCliProvider",
    "GitArgs",
    "McpSkillSyncResult",
    "ProfileManager",
    "SUPPORTED_CLI_PROVIDERS",
    "build_core_cli_tools",
    "build_sanitized_env",
    "plugin",
]
