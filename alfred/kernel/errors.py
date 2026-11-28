"""Microkernel exception hierarchy and LLM-recoverable tool validation errors."""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError


class ModuleError(Exception):
    """Base error raised by the microkernel or pluggable modules."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "MODULE_ERROR",
        module_id: str | None = None,
        status_code: int = 500,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.module_id = module_id
        self.status_code = status_code

    def to_payload(self) -> dict[str, Any]:
        """Serialize error for structured HTTP or internal responses."""
        payload: dict[str, Any] = {
            "error": self.code,
            "message": self.message,
        }
        if self.module_id is not None:
            payload["moduleId"] = self.module_id
        return payload


class ModuleDisabledError(ModuleError):
    """Raised when an operation targets a module that is not active."""

    def __init__(self, module_id: str, message: str | None = None) -> None:
        msg = message or f"Module '{module_id}' is not active"
        super().__init__(msg, code="MODULE_DISABLED", module_id=module_id, status_code=409)


class ModuleLoadError(ModuleError):
    """Raised when loading, validating, or migrating a module fails."""

    def __init__(self, message: str, *, module_id: str | None = None) -> None:
        super().__init__(message, code="MODULE_LOAD_ERROR", module_id=module_id, status_code=500)


class ModuleSecurityError(ModuleError):
    """Raised when a module violates path, sandbox, or isolation rules."""

    def __init__(self, message: str, *, module_id: str | None = None) -> None:
        super().__init__(
            message,
            code="MODULE_SECURITY_ERROR",
            module_id=module_id,
            status_code=403,
        )


class ForbiddenVaultAccessError(ModuleSecurityError):
    """Raised when a module requests a Vault secret outside its manifest scope."""

    def __init__(self, module_id: str, key_id: str) -> None:
        super().__init__(
            f"Module '{module_id}' is not permitted to access vault key '{key_id}'",
            module_id=module_id,
        )
        self.code = "FORBIDDEN_VAULT_ACCESS"
        self.key_id = key_id


class CircularDependencyError(ModuleLoadError):
    """Raised when active module `depends` relationships form a cycle."""

    def __init__(self, cycle: list[str]) -> None:
        self.cycle = cycle
        cycle_repr = " -> ".join(cycle)
        super().__init__(
            f"Circular module dependency detected: {cycle_repr}",
            module_id=cycle[0] if cycle else None,
        )
        self.code = "CIRCULAR_DEPENDENCY"
        self.status_code = 422


class MissingDependencyError(ModuleError):
    """Raised when a module requires another module that is missing or inactive."""

    def __init__(
        self,
        dependency_id: str,
        *,
        module_id: str | None = None,
        message: str | None = None,
    ) -> None:
        self.dependency_id = dependency_id
        owner = f"'{module_id}'" if module_id else "caller"
        msg = message or (
            f"Module {owner} requires active dependency '{dependency_id}', "
            "which is not declared in depends or not currently active"
        )
        super().__init__(
            msg,
            code="MISSING_DEPENDENCY",
            module_id=module_id,
            status_code=409,
        )


class ToolValidationError(ModuleError):
    """Raised or converted from Pydantic `ValidationError` on invalid tool inputs."""

    def __init__(
        self,
        tool_name: str,
        errors: list[dict[str, Any]],
        *,
        module_id: str | None = None,
    ) -> None:
        self.tool_name = tool_name
        self.errors = errors
        summary = _format_validation_errors(tool_name, errors)
        super().__init__(
            summary,
            code="TOOL_VALIDATION_ERROR",
            module_id=module_id,
            status_code=400,
        )

    @classmethod
    def from_pydantic(
        cls,
        tool_name: str,
        exc: ValidationError,
        *,
        module_id: str | None = None,
    ) -> ToolValidationError:
        """Convert a Pydantic `ValidationError` into an LLM-friendly validation error."""
        compact_errors: list[dict[str, Any]] = []
        for err in exc.errors(include_url=False):
            loc = ".".join(str(part) for part in err.get("loc", ())) or "<root>"
            compact_errors.append(
                {
                    "field": loc,
                    "message": str(err.get("msg", "Invalid value")),
                    "type": str(err.get("type", "value_error")),
                }
            )
        return cls(tool_name=tool_name, errors=compact_errors, module_id=module_id)

    def to_llm_message(self) -> str:
        """Return a concise structured error string so an LLM can self-correct its call."""
        return _format_validation_errors(self.tool_name, self.errors)


def _format_validation_errors(tool_name: str, errors: list[dict[str, Any]]) -> str:
    if not errors:
        return f"Invalid arguments for tool '{tool_name}'."
    parts = [f"{item['field']}: {item['message']}" for item in errors]
    return (
        f"Validation failed for tool '{tool_name}' ({len(parts)} issue(s)): "
        + "; ".join(parts)
        + ". Fix the arguments and retry."
    )
