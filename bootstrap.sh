#!/usr/bin/env bash
set -euo pipefail
REPO_URL="https://github.com/YOUR_GITHUB_USER/rajcv-infra.git"
CLONE_DIR="$HOME/rajcv-infra"
sudo apt-get update -qq && sudo apt-get upgrade -y -qq
sudo apt-get install -y -qq git curl python3 python3-pip python3-venv
python3 -m pip install --user ansible --quiet
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
if [ -d "$CLONE_DIR/.git" ]; then
  git -C "$CLONE_DIR" pull
else
  git clone "$REPO_URL" "$CLONE_DIR"
fi
cd "$CLONE_DIR"
ansible-playbook ansible/playbook.yml --connection=local -i "localhost," -K
