#Arrêter et empêcher le redémarrage au boot
 systemctl --user disable --now hermes-webhook.target

#Redémarrer proprement (relance tunnel + receiver, republie l’URL, resync les webhooks)
systemctl --user restart hermes-webhook.target

#Voir l’état
systemctl --user list-units 'hermes.*' --all
