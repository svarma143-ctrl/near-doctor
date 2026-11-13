async fn happy_path(e: &Env) {
    let r = e.lender.call(e.contract.id(), "fund_loan").gas(Gas::from_tgas(60)).transact().await.unwrap();
    e.worker.fast_forward(5).await.unwrap();
    let b1 = e.borrower.view_account().await.unwrap().balance;
    assert_eq!(b1 - b0, principal);
}
