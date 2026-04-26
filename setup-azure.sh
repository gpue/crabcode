#!/usr/bin/env bash
# setup-azure.sh — One-time Azure infrastructure setup for crabcode
# Run this locally with Azure CLI authenticated.
set -euo pipefail

RESOURCE_GROUP="wabo"
LOCATION="westeurope"
CONTAINER_APP_ENV="crabcode-env"
CONTAINER_APP_NAME="crabcode"
STORAGE_ACCOUNT="crabcodestorage"
FILE_SHARE="crabcode-workspace"
IMAGE="waboreg.azurecr.io/crabcode:latest"

echo "=== Using existing resource group: $RESOURCE_GROUP ==="

echo "=== Creating storage account ==="
az storage account create \
    --name "$STORAGE_ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Premium_LRS \
    --kind FileStorage

STORAGE_KEY=$(az storage account keys list \
    --account-name "$STORAGE_ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --query "[0].value" -o tsv)

echo "=== Creating file share ==="
az storage share create \
    --name "$FILE_SHARE" \
    --account-name "$STORAGE_ACCOUNT" \
    --account-key "$STORAGE_KEY" \
    --quota 100

echo "=== Creating Container Apps environment ==="
az containerapp env create \
    --name "$CONTAINER_APP_ENV" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION"

echo "=== Adding storage to environment ==="
az containerapp env storage set \
    --name "$CONTAINER_APP_ENV" \
    --resource-group "$RESOURCE_GROUP" \
    --storage-name crabcodestorage \
    --azure-file-account-name "$STORAGE_ACCOUNT" \
    --azure-file-account-key "$STORAGE_KEY" \
    --azure-file-share-name "$FILE_SHARE" \
    --access-mode ReadWrite

echo "=== Creating Container App (no public ingress — Tailscale only) ==="
az containerapp create \
    --name "$CONTAINER_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --environment "$CONTAINER_APP_ENV" \
    --image "$IMAGE" \
    --registry-server waboreg.azurecr.io \
    --registry-username "\$ACR_USERNAME" \
    --registry-password "\$ACR_PASSWORD" \
    --cpu 4 \
    --memory 8Gi \
    --min-replicas 1 \
    --max-replicas 1 \
    --ingress internal \
    --target-port 8080 \
    --env-vars \
        "AZURE_OPENAI_API_KEY=secretref:azure-openai-api-key" \
        "AZURE_OPENAI_BASE_URL=secretref:azure-openai-base-url" \
        "CLAWBOT_AZURE_RESPONSES_URL=secretref:clawbot-azure-responses-url" \
        "LINEAR_API_KEY=secretref:linear-api-key" \
        "TELEGRAM_BOT_TOKEN=secretref:telegram-bot-token" \
        "TELEGRAM_NOTIFY_TARGET=secretref:telegram-notify-target" \
        "TS_AUTHKEY=secretref:ts-authkey" \
        "TS_HOSTNAME=crabcode" \
        "GH_TOKEN=secretref:gh-token" \
        "LINEAR_ASSIGNEE_ID=secretref:linear-assignee-id"

echo ""
echo "=== Done! ==="
echo "Next steps:"
echo "  1. Set secrets: az containerapp secret set --name $CONTAINER_APP_NAME -g $RESOURCE_GROUP ..."
echo "  2. Add volume mount for /workspace (see Azure docs for Container Apps volume mounts)"
echo "  3. The app has NO public ingress — access it via Tailscale only"
echo "  4. Set GitHub Actions secrets: ACR_USERNAME, ACR_PASSWORD, AZURE_CREDENTIALS"
