#!/usr/bin/env bash
# Connects skyshift.me and www.skyshift.me to the Azure container app, each with
# a free HTTPS certificate that Azure renews automatically. Run it after
# deploy/azure-setup.sh, once the DNS records it printed are in place:
#
#   bash deploy/azure-domain.sh
#
# It first checks the records through a public resolver and stops, changing
# nothing, if they have not spread yet. Running it again is safe.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep /subscriptions/... arguments intact

RG="${RG:-skyshift}"
APP="${APP:-skyshift}"
ENVIRONMENT="${ENVIRONMENT:-skyshift-env}"
DOMAIN="${DOMAIN:-skyshift.me}"

q() { az "$@" --output tsv | tr -d '\r'; }
step() { printf '\n==> %s\n' "$*"; }
# lookup TYPE NAME: the record values a public resolver sees, one per line.
lookup() {
  curl -fsS "https://dns.google/resolve?name=$2&type=$1" | sed 's/\\"//g' \
    | sed -n 's/.*"Answer":\[\([^]]*\)\].*/\1/p' \
    | grep -o '"data":"[^"]*"' | cut -d'"' -f4 | sed 's/\.$//' || true
}

FQDN=$(q containerapp show --name "$APP" --resource-group "$RG" --query properties.configuration.ingress.fqdn)
STATIC_IP=$(q containerapp env show --name "$ENVIRONMENT" --resource-group "$RG" --query properties.staticIp)
VERIFY=$(q containerapp show --name "$APP" --resource-group "$RG" --query properties.customDomainVerificationId)

step "Checking DNS for $DOMAIN"
problems=0
# expect TYPE NAME VALUE: NAME must have exactly that one value.
expect() {
  local found; found=$(lookup "$1" "$2")
  if [ "$found" = "$3" ]; then
    printf '  ok       %-6s %-22s %s\n' "$1" "$2" "$3"
  else
    printf '  waiting  %-6s %-22s should be %s, now: %s\n' "$1" "$2" "$3" "$(echo ${found:-nothing})"
    problems=1
  fi
}
expect A "$DOMAIN" "$STATIC_IP"
expect TXT "asuid.$DOMAIN" "$VERIFY"
expect CNAME "www.$DOMAIN" "$FQDN"
expect TXT "asuid.www.$DOMAIN" "$VERIFY"
if [ -n "$(lookup AAAA "$DOMAIN")" ]; then
  echo "  waiting  AAAA   $DOMAIN has IPv6 records; delete them at Namecheap"
  problems=1
fi
if [ "$problems" = 1 ]; then
  cat <<EOF

DNS is not ready yet, so nothing was changed. At Namecheap (Advanced DNS) keep
only the four records azure-setup.sh printed for @, asuid, www and asuid.www,
and remove any other A, AAAA, CNAME or URL Redirect records for @ and www.
Changes usually spread in 5 to 30 minutes; run this script again then.
EOF
  exit 1
fi

# attach HOSTNAME VALIDATION: add the hostname and bind a managed certificate.
attach() {
  step "Connecting $1 (the certificate can take 5 to 20 minutes)"
  if [ -z "$(q containerapp hostname list --name "$APP" --resource-group "$RG" --query "[?name=='$1'].name")" ]; then
    az containerapp hostname add --hostname "$1" --name "$APP" --resource-group "$RG" --output none
  fi
  if [ "$(q containerapp hostname list --name "$APP" --resource-group "$RG" --query "[?name=='$1'].bindingType | [0]")" != SniEnabled ]; then
    az containerapp hostname bind --hostname "$1" --name "$APP" --resource-group "$RG" \
      --environment "$ENVIRONMENT" --validation-method "$2" --output none
  fi
  echo "  https://$1/"
}
attach "$DOMAIN" HTTP
attach "www.$DOMAIN" CNAME

echo
echo "Done. SkyShift is at https://$DOMAIN/ and https://www.$DOMAIN/"
