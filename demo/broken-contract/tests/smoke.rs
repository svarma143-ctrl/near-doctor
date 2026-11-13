// Integration smoke test. Uses anyhow, which Cargo.toml does not declare yet.

#[test]
fn smoke() -> anyhow::Result<()> {
    assert_eq!(1 + 1, 2);
    Ok(())
}
