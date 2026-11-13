import { Account, actions } from "near-api-js";
const r = await account.signAndSendTransaction({
  receiverId: contractId,
  actions: [actions.functionCall("request_loan", args, gas, deposit)],
  waitUntil: "FINAL",
  throwOnFailure: false,
});
if (r.status?.Failure) {
  console.log("rejected as expected");
}
