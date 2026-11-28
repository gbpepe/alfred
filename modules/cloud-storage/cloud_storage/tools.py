"""5 strict Pydantic v2 LLM tools for `cloud-storage`."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from alfred.kernel.errors import ModuleDisabledError, ModuleError
from alfred.kernel.types import (
    ModuleToolDefinition,
    ToolExecutionContext,
    ToolExecutionResult,
)

from .engine import CloudStorageEngine
from .models import (
    MODULE_ID,
    CloudItemKindFilter,
    CloudProviderId,
    CloudShareRole,
    CloudUploadConflictMode,
)


class CloudListArgs(BaseModel):
    """Pydantic v2 arguments for `cloud_list`."""

    model_config = ConfigDict(extra="forbid")

    provider: CloudProviderId | None = Field(
        default=None,
        description="Cloud provider ('gdrive', 'onedrive', or 'dropbox').",
    )
    account: str | None = Field(
        default=None,
        description="Optional named account alias or connected email address.",
    )
    folder_ref: str | None = Field(
        default=None,
        description="Optional folder ID or relative path to list.",
    )
    query: str | None = Field(
        default=None,
        description="Optional search query string.",
    )
    kind: CloudItemKindFilter = Field(
        default="all",
        description="Filter item kind ('all', 'file', or 'folder').",
    )
    limit: int = Field(
        default=50,
        ge=1,
        le=200,
        description="Maximum number of items to return (1..200).",
    )


class CloudMkdirArgs(BaseModel):
    """Pydantic v2 arguments for `cloud_mkdir`."""

    model_config = ConfigDict(extra="forbid")

    path_or_name: str = Field(
        min_length=1,
        description="Folder name or relative nested folder path to create.",
    )
    parent_ref: str | None = Field(
        default=None,
        description="Optional parent folder ID or relative path.",
    )
    provider: CloudProviderId | None = None
    account: str | None = None


class CloudUploadArgs(BaseModel):
    """Pydantic v2 arguments for `cloud_upload`."""

    model_config = ConfigDict(extra="forbid")

    local_path: str = Field(
        min_length=1,
        description="Workspace- or data_dir-confined local file path to upload.",
    )
    remote_path_or_name: str | None = Field(
        default=None,
        description="Optional remote filename or relative destination path.",
    )
    parent_ref: str | None = Field(
        default=None,
        description="Optional remote parent folder ID or path.",
    )
    on_conflict: CloudUploadConflictMode = Field(
        default="update_in_place",
        description="Conflict policy ('update_in_place', 'autorename', or 'fail').",
    )
    provider: CloudProviderId | None = None
    account: str | None = None


class CloudDownloadArgs(BaseModel):
    """Pydantic v2 arguments for `cloud_download`."""

    model_config = ConfigDict(extra="forbid")

    file_ref_or_path: str = Field(
        min_length=1,
        description="Remote file ID or confined cloud path.",
    )
    local_dest_path: str = Field(
        min_length=1,
        description="Workspace- or data_dir-confined destination file path.",
    )
    export_format: str | None = Field(
        default=None,
        description="Export format for Google Docs/Sheets/Slides (e.g. md, csv, pdf, png).",
    )
    provider: CloudProviderId | None = None
    account: str | None = None


class CloudShareArgs(BaseModel):
    """Pydantic v2 arguments for `cloud_share`."""

    model_config = ConfigDict(extra="forbid")

    file_ref_or_path: str = Field(
        min_length=1,
        description="Remote file ID or path to share.",
    )
    email: str | None = Field(
        default=None,
        description="Recipient email address (optional if default share email is configured).",
    )
    role: CloudShareRole = Field(
        default="reader",
        description="Permission role ('reader' or 'writer').",
    )
    public_link: bool = Field(
        default=False,
        description="Request an anonymous public link (requires cloud_allow_public_links=true).",
    )
    notify: bool = Field(
        default=False,
        description="Whether the provider should email a notification.",
    )
    expires_in_days: int | None = Field(
        default=None,
        ge=1,
        le=365,
        description="Optional link expiration in days.",
    )
    provider: CloudProviderId | None = None
    account: str | None = None


def _require_engine(
    ctx: ToolExecutionContext,
    engine_getter: Callable[[], CloudStorageEngine | None],
) -> CloudStorageEngine:
    svc = ctx.module_ctx.modules.get_service(MODULE_ID)
    if isinstance(svc, CloudStorageEngine):
        return svc
    engine = engine_getter()
    if isinstance(engine, CloudStorageEngine):
        return engine
    raise ModuleDisabledError(MODULE_ID)


def build_cloud_tools(
    engine_getter: Callable[[], CloudStorageEngine | None],
) -> Sequence[ModuleToolDefinition[Any]]:
    """Build the 5 `cloud_*` LLM tools backed by `CloudStorageEngine`."""

    async def exec_cloud_list(
        args: CloudListArgs,
        ctx: ToolExecutionContext,
    ) -> ToolExecutionResult:
        try:
            engine = _require_engine(ctx, engine_getter)
            res = await engine.list_files(
                provider=args.provider,
                account=args.account,
                folder_ref=args.folder_ref,
                query=args.query,
                kind=args.kind,
                limit=args.limit,
            )
            return ToolExecutionResult(ok=True, output=res.model_dump(mode="json"))
        except ModuleError as exc:
            return ToolExecutionResult(ok=False, error=exc.message, error_code=exc.code)

    async def exec_cloud_mkdir(
        args: CloudMkdirArgs,
        ctx: ToolExecutionContext,
    ) -> ToolExecutionResult:
        try:
            engine = _require_engine(ctx, engine_getter)
            res = await engine.make_folder(
                path_or_name=args.path_or_name,
                parent_ref=args.parent_ref,
                provider=args.provider,
                account=args.account,
            )
            return ToolExecutionResult(ok=True, output=res.model_dump(mode="json"))
        except ModuleError as exc:
            return ToolExecutionResult(ok=False, error=exc.message, error_code=exc.code)

    async def exec_cloud_upload(
        args: CloudUploadArgs,
        ctx: ToolExecutionContext,
    ) -> ToolExecutionResult:
        try:
            engine = _require_engine(ctx, engine_getter)
            prov, acc, item = await engine.upload_file(
                local_path=args.local_path,
                workspace_dir=ctx.workspace_dir,
                protected_paths=ctx.protected_paths,
                remote_path_or_name=args.remote_path_or_name,
                parent_ref=args.parent_ref,
                on_conflict=args.on_conflict,
                provider=args.provider,
                account=args.account,
            )
            return ToolExecutionResult(
                ok=True,
                output={
                    "provider": prov,
                    "account": acc,
                    "item": item.model_dump(mode="json"),
                },
            )
        except ModuleError as exc:
            return ToolExecutionResult(ok=False, error=exc.message, error_code=exc.code)

    async def exec_cloud_download(
        args: CloudDownloadArgs,
        ctx: ToolExecutionContext,
    ) -> ToolExecutionResult:
        try:
            engine = _require_engine(ctx, engine_getter)
            prov, acc, result = await engine.download_file(
                file_ref_or_path=args.file_ref_or_path,
                local_dest_path=args.local_dest_path,
                workspace_dir=ctx.workspace_dir,
                protected_paths=ctx.protected_paths,
                export_format=args.export_format,
                provider=args.provider,
                account=args.account,
            )
            return ToolExecutionResult(
                ok=True,
                output={
                    "provider": prov,
                    "account": acc,
                    "result": result.model_dump(mode="json"),
                },
            )
        except ModuleError as exc:
            return ToolExecutionResult(ok=False, error=exc.message, error_code=exc.code)

    async def exec_cloud_share(
        args: CloudShareArgs,
        ctx: ToolExecutionContext,
    ) -> ToolExecutionResult:
        try:
            engine = _require_engine(ctx, engine_getter)
            res = await engine.share_file(
                file_ref_or_path=args.file_ref_or_path,
                email=args.email,
                role=args.role,
                public_link=args.public_link,
                notify=args.notify,
                expires_in_days=args.expires_in_days,
                provider=args.provider,
                account=args.account,
            )
            return ToolExecutionResult(ok=True, output=res.model_dump(mode="json"))
        except ModuleError as exc:
            return ToolExecutionResult(ok=False, error=exc.message, error_code=exc.code)

    return (
        ModuleToolDefinition(
            name="cloud_list",
            description="List or search items across Google Drive, OneDrive, or Dropbox.",
            args_model=CloudListArgs,
            execute=exec_cloud_list,
            module_id=MODULE_ID,
        ),
        ModuleToolDefinition(
            name="cloud_mkdir",
            description="Create folder(s) in Google Drive, OneDrive, or Dropbox.",
            args_model=CloudMkdirArgs,
            execute=exec_cloud_mkdir,
            module_id=MODULE_ID,
        ),
        ModuleToolDefinition(
            name="cloud_upload",
            description="Upload a confined file in 8 MiB chunks after secret scanning.",
            args_model=CloudUploadArgs,
            execute=exec_cloud_upload,
            module_id=MODULE_ID,
        ),
        ModuleToolDefinition(
            name="cloud_download",
            description="Stream-download a cloud file (or Google export) to local storage.",
            args_model=CloudDownloadArgs,
            execute=exec_cloud_download,
            module_id=MODULE_ID,
        ),
        ModuleToolDefinition(
            name="cloud_share",
            description="Share a cloud file by email or policy-gated public link.",
            args_model=CloudShareArgs,
            execute=exec_cloud_share,
            module_id=MODULE_ID,
        ),
    )
