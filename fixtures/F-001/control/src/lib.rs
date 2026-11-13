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

// fn amount_owed(principal: u128) -> u128 is only a comment here
const NOTE: &str = "fn amount_owed() {} inside a string";

fn compute_owed(principal: u128) -> u128 {
    principal
}

#[cfg(test)]
mod tests {
    // same name, different module: no collision
    fn amount_owed() {}
}
