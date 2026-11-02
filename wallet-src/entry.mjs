// Source of widget/vendor/wallet.js (bundled with esbuild so the widget needs no build step: `pnpm --dir wallet-src build`).
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { actionCreators } from '@near-js/transactions';
import modalCss from '@near-wallet-selector/modal-ui/styles.css';

let ready;
/** One selector per page (testnet). Resolves to a small API used by the widget and the check-in page. */
export function initWallet({ network = 'testnet', contractId } = {}) {
  ready ??= (async () => {
    if (!document.getElementById('showup-wallet-css')) {
      const st = document.createElement('style'); st.id = 'showup-wallet-css'; st.textContent = modalCss; document.head.appendChild(st);
    }
    const selector = await setupWalletSelector({ network, modules: [setupMyNearWallet(), setupMeteorWallet()] });
    const modal = setupModal(selector, { contractId, description: 'Sign in with a NEAR testnet wallet to RSVP. ShowUp only asks your wallet to sign the exact RSVP, cancel or check-in call.' });
    const accountId = () => selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
    return {
      selector, modal, accountId,
      onChange(fn) { return selector.store.observable.subscribe(() => fn(accountId())); },
      signIn() { modal.show(); },
      async signOut() { if (selector.isSignedIn()) await (await selector.wallet()).signOut(); },
      /** Sign + send one FunctionCall. Browser wallets redirect away and return to `callbackUrl`. */
      async call(receiverId, methodName, args = {}, { deposit = '0', gas = 30_000_000_000_000n, callbackUrl = location.href } = {}) {
        const wallet = await selector.wallet();
        return wallet.signAndSendTransaction({ receiverId, callbackUrl,
          actions: [actionCreators.functionCall(methodName, args, BigInt(gas), BigInt(deposit))] });
      },
    };
  })();
  return ready;
}
