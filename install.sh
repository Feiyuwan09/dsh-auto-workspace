#!/usr/bin/env bash
# install.sh — dsh-auto-workspace 一键安装
# 用法：
#   ./install.sh                 安装到默认 profile（用户目录下 .dsh/profiles 里的唯一 profile）
#   ./install.sh desktop         安装到名为 desktop 的 profile
#   ./install.sh /path/to/profile 安装到指定 profile 目录（含 package.json 与 pnpm-workspace.yaml）
set -euo pipefail

# 依赖工具：jq、任一包管理器（pnpm / corepack / npm）
DIE() { printf '\n [错误] %s\n\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR=""

case "$#" in
  0)
    # 自动探测：唯一 profile
    profiles=()
    if [[ -d "$DSH_HOME/profiles" ]]; then
      for p in "$DSH_HOME"/profiles/*/; do
        [[ -f "${p}package.json" ]] && profiles+=("${p%/}")
      done
    fi
    if [[ ${#profiles[@]} -eq 1 ]]; then
      PROFILE_DIR="${profiles[0]}"
    else
      DIE "在 $DSH_HOME/profiles 下找到 ${#profiles[@]} 个 profile，无法自动确定。请显式指定：./install.sh <profile 名或目录>"
    fi
    ;;
  1)
    ARG="$1"
    if [[ -f "$ARG/package.json" ]]; then
      PROFILE_DIR="$(cd "$ARG" && pwd)"
    elif [[ -f "$DSH_HOME/profiles/$ARG/package.json" ]]; then
      PROFILE_DIR="$DSH_HOME/profiles/$ARG"
    else
      DIE "没有找到 profile：$ARG"
    fi
    ;;
  *)
    DIE "用法：$0 [<profile 名或目录>]"
    ;;
esac

[[ -f "$PROFILE_DIR/package.json" ]] || DIE "$PROFILE_DIR/package.json 不存在"

printf '\n ============================================================\n'
printf '   dsh-auto-workspace 一键安装\n'
printf '   目标 profile: %s\n' "$PROFILE_DIR"
printf ' ============================================================\n\n'

# 1. 备份 package.json
TS="$(date +%Y%m%d_%H%M%S)"
BACKUP="$PROFILE_DIR/package.json.bak-auto-workspace-$TS"
cp "$PROFILE_DIR/package.json" "$BACKUP"
printf ' [1/5] 已备份 package.json -> %s\n' "$BACKUP"

# 2. 拷贝插件
PLUGIN_DIR="$DSH_HOME/plugins/dsh-auto-workspace"
if [[ -d "$PLUGIN_DIR" ]]; then
  printf ' [2/5] 已存在 %s，备份后覆盖更新\n' "$PLUGIN_DIR"
  mv "$PLUGIN_DIR" "$PLUGIN_DIR.bak-$TS"
fi
mkdir -p "$DSH_HOME/plugins"
# 跳过本仓库开发用文件
rsync -a --exclude '.git' --exclude 'copyexclude.txt' \
      "$SCRIPT_DIR/" "$PLUGIN_DIR/" 2>/dev/null || \
  cp -R "$SCRIPT_DIR" "$PLUGIN_DIR"
rm -rf "$PLUGIN_DIR/.git" 2>/dev/null || true
printf ' [2/5] 已拷贝插件 -> %s\n' "$PLUGIN_DIR"

# 3. 修改 package.json（jq 安全编辑，保留 BOM/缩进问题由 jq 处理）
printf ' [3/5] 检查 profile 的 package.json...\n'
if ! grep -q 'dsh-auto-workspace' "$PROFILE_DIR/package.json"; then
  command -v jq >/dev/null 2>&1 || DIE "未找到 jq（brew install jq / apt install jq），且 package.json 尚未注册本插件"
  TMP="$(mktemp)"
  jq '.dependencies["dsh-auto-workspace"] = "file:../../plugins/dsh-auto-workspace"
    | if (.dsh.profile.bundles | index("dsh-auto-workspace")) == null
      then .dsh.profile.bundles += ["dsh-auto-workspace"] else . end' \
    "$PROFILE_DIR/package.json" > "$TMP"
  mv "$TMP" "$PROFILE_DIR/package.json"
  printf '        package.json 已更新\n'
else
  printf '        已注册过 dsh-auto-workspace，跳过修改\n'
fi

# 4. 安装依赖
printf ' [4/5] 安装依赖（链接插件到 profile）...\n'
cd "$PROFILE_DIR"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install
elif command -v corepack >/dev/null 2>&1; then
  corepack pnpm install
elif command -v npm >/dev/null 2>&1; then
  npm install
else
  DIE "没有找到 pnpm / corepack / npm，请先安装 Node.js 或 pnpm"
fi
[[ -f "$PROFILE_DIR/node_modules/dsh-auto-workspace/lib/index.mjs" ]] || \
  printf ' [警告] node_modules 里没有出现 dsh-auto-workspace，重启 Harness 前请确认\n'

# 5. 完成
printf ' [5/5] 安装完成！\n\n'
printf '  下一步：重启 DeepSeek Harness 使插件生效。\n'
printf '  之后新建分区将不再弹目录选择框，默认创建 default-workspace[-N]，\n'
printf '  可在 插件管理页 -> dsh-auto-workspace -> 配置 里修改目录名前缀。\n\n'
printf '  备份文件：%s\n' "$BACKUP"
