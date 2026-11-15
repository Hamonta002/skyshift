#!/usr/bin/env bash
# One-time Azure setup for running SkyShift on your own subscription (Azure for
# Students works). Run it in Azure Cloud Shell (Bash), or in any Bash where you
# have run `az login`:
#
#   bash deploy/azure-setup.sh
#   LOCATION=eastus bash deploy/azure-setup.sh      # pick another region
#
# In one resource group it creates:
#   - a container registry that the GitHub workflow pushes images to,
#   - a Container Apps environment and the `skyshift` app (scales to zero),
#   - the `skyshift-github` managed identity that GitHub Actions signs in as
#     with OpenID Connect (no password stored); it trusts only `main` of
#     $GITHUB_REPO and can only manage this resource group.
# Running it again is safe: it reuses what exists and prints the values again.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep /subscriptions/... arguments intact

GITHUB_REPO="${GITHUB_REPO:-ihfaz297/skyshift}"
LOCATION="${LOCATION:-southeastasia}"
RG="${RG:-skyshift}"
APP="${APP:-skyshift}"
ENVIRONMENT="${ENVIRONMENT:-skyshift-env}"
IDENTITY="${IDENTITY:-skyshift-github}"
DOMAIN="${DOMAIN:-skyshift.me}"

# az on Windows ends tsv lines with \r; strip it so values compare and print cleanly.
q() { az "$@" --output tsv | tr -d '\r'; }
step() { printf '\n==> %s\n' "$*"; }
# grant ROLE SCOPE PRINCIPAL_ID, unless that assignment already exists.
grant() {
  if [ -z "$(q role assignment list --role "$1" --scope "$2" --query "[?principalId=='$3'].id | [0]")" ]; then
    az role assignment create --role "$1" --scope "$2" --assignee-object-id "$3" \
      --assignee-principal-type ServicePrincipal --output none
  fi
}
trap 'echo; echo "Setup stopped on the error above. If it mentions RequestDisallowedByPolicy or a"; echo "location, run it again with an allowed region: LOCATION=<region> bash $0"' ERR

step "Checking the Azure sign-in"
SUBSCRIPTION_ID=$(q account show --query id)
TENANT_ID=$(q account show --query tenantId)
echo "Subscription: $(q account show --query name) ($SUBSCRIPTION_ID)"

step "Checking that $LOCATION is an allowed region"
ALLOWED=$(q policy assignment list --disable-scope-strict-match \
  --query "[].parameters.listOfAllowedLocations.value[]" 2>/dev/null || true)
if [ -n "$ALLOWED" ] && ! grep -qx "$LOCATION" <<<"$ALLOWED"; then
  trap - ERR
  echo "This subscription only allows these regions:"
  sed 's/^/  /' <<<"$ALLOWED"
  echo "Run again with one of them, for example:"
  echo "  LOCATION=$(head -n 1 <<<"$ALLOWED") bash $0"
  exit 1
fi
echo "OK"

step "Registering the Azure services SkyShift uses (the first time takes a few minutes)"
for namespace in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry Microsoft.ManagedIdentity; do
  az provider register --namespace "$namespace" --wait --output none
done
az extension add --name containerapp --upgrade --only-show-errors --output none

step "Resource group $RG"
az group create --name "$RG" --location "$LOCATION" --output none
RG_ID=$(q group show --name "$RG" --query id)

step "Container registry"
REGISTRY=$(q acr list --resource-group "$RG" --query "[0].name")
if [ -z "$REGISTRY" ]; then
  # Registry names are global across Azure, so add a random suffix.
  REGISTRY="skyshift$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  az acr create --name "$REGISTRY" --resource-group "$RG" --location "$LOCATION" --sku Basic --output none
fi
ACR_ID=$(q acr show --name "$REGISTRY" --query id)
echo "$REGISTRY.azurecr.io"

step "Container Apps environment $ENVIRONMENT (takes a few minutes)"
if ! az containerapp env show --name "$ENVIRONMENT" --resource-group "$RG" --output none 2>/dev/null; then
  # Ask for a standard (workload profiles) environment: the CLI can otherwise make an
  # "express" one, which supports neither custom domains nor system-assigned identities.
  args=()
  help=$(az containerapp env create --help 2>/dev/null || true)
  if grep -q -- --environment-mode <<<"$help"; then
    args+=(--environment-mode WorkloadProfiles)
  fi
  # Reuse the Log Analytics workspace an earlier attempt made instead of adding another.
  WORKSPACE=$(q monitor log-analytics workspace list --resource-group "$RG" --query "[0].name")
  if [ -n "$WORKSPACE" ]; then
    args+=(--logs-workspace-id "$(q monitor log-analytics workspace show --resource-group "$RG" \
      --workspace-name "$WORKSPACE" --query customerId)")
    args+=(--logs-workspace-key "$(q monitor log-analytics workspace get-shared-keys --resource-group "$RG" \
      --workspace-name "$WORKSPACE" --query primarySharedKey)")
  fi
  az containerapp env create --name "$ENVIRONMENT" --resource-group "$RG" --location "$LOCATION" \
    "${args[@]}" --output none
fi
if [ "$(q containerapp env show --name "$ENVIRONMENT" --resource-group "$RG" --query properties.environmentMode)" = Express ]; then
  trap - ERR
  cat <<EOF
$ENVIRONMENT is an "express" environment, which cannot have a custom domain or use
the app's own identity to pull images. Delete it and its app, then run this again:
  az containerapp delete --name $APP --resource-group $RG --yes
  az containerapp env delete --name $ENVIRONMENT --resource-group $RG --yes
EOF
  exit 1
fi
# The create command can return while the environment is still being built; wait for it.
printf 'Waiting for the environment to be ready'
for attempt in $(seq 1 90); do
  state=$(q containerapp env show --name "$ENVIRONMENT" --resource-group "$RG" --query properties.provisioningState)
  case "$state" in
    Succeeded) echo " ready"; break ;;
    Failed | Canceled | UpgradeFailed | ScheduledForDelete)
      trap - ERR
      echo; echo "Azure reports the environment as $state. Delete it and run this again:"
      echo "  az containerapp env delete --name $ENVIRONMENT --resource-group $RG --yes"
      exit 1 ;;
  esac
  if [ "$attempt" = 90 ]; then
    trap - ERR
    echo; echo "Still $state after 30 minutes. Run this script again later; it picks up from here."
    exit 1
  fi
  printf '.'; sleep 20
done

step "Container app $APP"
if ! az containerapp show --name "$APP" --resource-group "$RG" --output none 2>/dev/null; then
  # A placeholder that also listens on 8080; the first GitHub deploy replaces it with SkyShift.
  az containerapp create --name "$APP" --resource-group "$RG" --environment "$ENVIRONMENT" \
    --image mcr.microsoft.com/dotnet/samples:aspnetapp \
    --target-port 8080 --ingress external \
    --cpu 0.5 --memory 1Gi --min-replicas 0 --max-replicas 2 \
    --system-assigned --output none
fi
# The app pulls from the registry with its own identity, so no registry password exists.
APP_PRINCIPAL=$(q containerapp show --name "$APP" --resource-group "$RG" --query identity.principalId)
grant AcrPull "$ACR_ID" "$APP_PRINCIPAL"
az containerapp registry set --name "$APP" --resource-group "$RG" \
  --server "$REGISTRY.azurecr.io" --identity system --output none

step "GitHub sign-in identity $IDENTITY"
az identity create --name "$IDENTITY" --resource-group "$RG" --location "$LOCATION" --output none
CLIENT_ID=$(q identity show --name "$IDENTITY" --resource-group "$RG" --query clientId)
PRINCIPAL_ID=$(q identity show --name "$IDENTITY" --resource-group "$RG" --query principalId)
if ! az identity federated-credential show --name github-main --identity-name "$IDENTITY" \
  --resource-group "$RG" --output none 2>/dev/null; then
  az identity federated-credential create --name github-main --identity-name "$IDENTITY" \
    --resource-group "$RG" --issuer https://token.actions.githubusercontent.com \
    --subject "repo:$GITHUB_REPO:ref:refs/heads/main" \
    --audiences api://AzureADTokenExchange --output none
fi
grant Contributor "$RG_ID" "$PRINCIPAL_ID"
grant AcrPush "$ACR_ID" "$PRINCIPAL_ID"

FQDN=$(q containerapp show --name "$APP" --resource-group "$RG" --query properties.configuration.ingress.fqdn)
STATIC_IP=$(q containerapp env show --name "$ENVIRONMENT" --resource-group "$RG" --query properties.staticIp)
VERIFY=$(q containerapp show --name "$APP" --resource-group "$RG" --query properties.customDomainVerificationId)
trap - ERR

cat <<EOF

==============================================================================
 Azure is ready. Run this script again any time to see these values.

 1. GitHub secrets: https://github.com/$GITHUB_REPO/settings/secrets/actions
    "Secrets" tab, "New repository secret", three times:
      AZURE_CLIENT_ID        $CLIENT_ID
      AZURE_TENANT_ID        $TENANT_ID
      AZURE_SUBSCRIPTION_ID  $SUBSCRIPTION_ID
    "Variables" tab, "New repository variable":
      AZURE_REGISTRY         $REGISTRY

 2. Deploy: https://github.com/$GITHUB_REPO/actions
    Enable workflows if asked, open "Deploy to Azure", click "Run workflow".
    When it finishes (about 10 minutes) SkyShift is live at
      https://$FQDN/

 3. DNS at Namecheap: Domain List > $DOMAIN > Manage > Advanced DNS.
    Delete the four A records 185.199.x.153 and the www CNAME to github.io,
    then add these four records:
      Type    Host        Value
      A       @           $STATIC_IP
      TXT     asuid       $VERIFY
      CNAME   www         $FQDN
      TXT     asuid.www   $VERIFY

 4. When the DNS change has spread (usually 5 to 30 minutes):
      bash deploy/azure-domain.sh
==============================================================================
EOF
