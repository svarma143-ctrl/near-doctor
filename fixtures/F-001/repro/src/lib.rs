use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct Contract {}

#[near]
impl Contract {
    pub fn amount_owed(&self) -> u128 {
        0
    }
}

fn amount_owed(principal: u128) -> u128 {
    principal
}
