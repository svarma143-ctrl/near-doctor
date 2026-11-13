const r = await account.callFunctionRaw({ contractId, methodName: "request_loan", args });
if (r.status?.Failure) {
  console.log("rejected as expected");
}
