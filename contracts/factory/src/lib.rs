//! ShowUp factory: one call creates `<name>.<factory>`, deploys the embedded escrow wasm
//! and initializes it with the caller as host. Build the escrow wasm first (`pnpm build:contract`).
use near_sdk::json_types::U64;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult};

pub const ESCROW_WASM: &[u8] = include_bytes!("../../../target/wasm32-unknown-unknown/release/showup_escrow.wasm");
const INIT_GAS: Gas = Gas::from_tgas(30);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// Headroom on top of code storage for the escrow state (guests map, etc.).
const STATE_BUFFER: NearToken = NearToken::from_millinear(500);

#[near(serializers = [json])]
#[derive(Clone, Copy)]
pub struct Windows { pub cancel_deadline_ns: U64, pub checkin_start_ns: U64, pub checkin_end_ns: U64 }

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EventRecord { pub name: String, pub account_id: AccountId, pub host: AccountId, pub created_at_ns: U64 }

/// Minimum attached deposit to create an event: storage for the escrow code plus a state buffer.
pub fn min_deposit() -> NearToken {
    env::storage_byte_cost().saturating_mul(ESCROW_WASM.len() as u128).saturating_add(STATE_BUFFER)
}

/// Sub-account labels: 2..=32 chars of [a-z0-9_-], must start/end alphanumeric, no dots.
pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    (2..=32).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
        && b[0].is_ascii_alphanumeric() && b[b.len() - 1].is_ascii_alphanumeric()
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory { events: IterableMap<String, EventRecord> }

#[near]
impl Factory {
    #[init]
    pub fn new() -> Self { Self { events: IterableMap::new(b"e") } }

    /// Attach at least `get_min_deposit()`; all of it funds the new event account.
    #[payable]
    pub fn create_event(&mut self, name: String, deposit: NearToken, capacity: u32, windows: Windows) -> Promise {
        require!(valid_name(&name), "invalid name: 2-32 chars of a-z 0-9 - _");
        require!(!self.events.contains_key(&name), "event name taken");
        require!(capacity > 0 && deposit.as_yoctonear() > 0, "capacity and deposit must be > 0");
        let (c, s, e) = (windows.cancel_deadline_ns.0, windows.checkin_start_ns.0, windows.checkin_end_ns.0);
        require!(c <= s && s < e, "bad windows");
        let attached = env::attached_deposit();
        require!(attached >= min_deposit(), format!("attach at least {} yocto", min_deposit().as_yoctonear()));
        let host = env::predecessor_account_id();
        let account_id: AccountId = format!("{name}.{}", env::current_account_id()).parse()
            .unwrap_or_else(|_| env::panic_str("invalid sub-account"));
        let args = near_sdk::serde_json::json!({ "host": host, "deposit": deposit, "capacity": capacity,
            "cancel_deadline_ns": c, "checkin_start_ns": s, "checkin_end_ns": e });
        Promise::new(account_id.clone())
            .create_account()
            .transfer(attached)
            .deploy_contract(ESCROW_WASM.to_vec())
            .function_call("new".into(), args.to_string().into_bytes(), NearToken::from_yoctonear(0), INIT_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS)
                .on_event_created(name, account_id, host, attached))
    }

    /// Records the event on success; on failure the batch reverted, so refund the host.
    #[private]
    pub fn on_event_created(&mut self, name: String, account_id: AccountId, host: AccountId, attached: NearToken) -> bool {
        if matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            let rec = EventRecord { name: name.clone(), account_id, host, created_at_ns: U64(env::block_timestamp()) };
            self.events.insert(name, rec);
            true
        } else {
            Promise::new(host).transfer(attached);
            false
        }
    }

    pub fn get_events(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<EventRecord> {
        self.events.values().skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize).cloned().collect()
    }
    pub fn get_event(&self, name: String) -> Option<EventRecord> { self.events.get(&name).cloned() }
    pub fn get_min_deposit(&self) -> NearToken { min_deposit() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, RuntimeFeesConfig};

    const D: u128 = 10u128.pow(24);
    fn acc(s: &str) -> AccountId { s.parse().unwrap() }
    fn ctx(who: &str, dep: u128) -> near_sdk::VMContext {
        VMContextBuilder::new().current_account_id(acc("factory.testnet")).predecessor_account_id(acc(who))
            .attached_deposit(NearToken::from_yoctonear(dep)).block_timestamp(42).build()
    }
    fn win(c: u64, s: u64, e: u64) -> Windows { Windows { cancel_deadline_ns: U64(c), checkin_start_ns: U64(s), checkin_end_ns: U64(e) } }
    fn create(f: &mut Factory, name: &str) {
        f.create_event(name.into(), NearToken::from_millinear(100), 50, win(100, 200, 300));
    }
    fn with_result(r: PromiseResult) {
        testing_env!(ctx("factory.testnet", 0), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![r]);
    }

    #[test] fn embeds_escrow_wasm() { assert_eq!(&ESCROW_WASM[..4], b"\0asm"); assert!(ESCROW_WASM.len() > 10_000); }

    #[test] fn create_event_batches_create_deploy_init() {
        testing_env!(ctx("alice.testnet", 5 * D)); let mut f = Factory::new();
        create(&mut f, "party-1");
        let rs = get_created_receipts();
        let ev = rs.iter().find(|r| r.receiver_id == acc("party-1.factory.testnet")).expect("event receipt");
        assert!(matches!(ev.actions[0], MockAction::CreateAccount { .. }));
        assert!(matches!(ev.actions[1], MockAction::Transfer { deposit, .. } if deposit == NearToken::from_yoctonear(5 * D)));
        assert!(matches!(&ev.actions[2], MockAction::DeployContract { code, .. } if code.as_slice() == ESCROW_WASM));
        match &ev.actions[3] {
            MockAction::FunctionCallWeight { method_name, args, .. } => {
                assert_eq!(method_name, b"new");
                let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
                assert_eq!(v["host"], "alice.testnet");
                assert_eq!(v["capacity"], 50);
                assert_eq!(v["deposit"], "100000000000000000000000");
                assert_eq!(v["checkin_end_ns"], 300);
            }
            a => panic!("expected init call, got {a:?}"),
        }
        assert!(rs.iter().any(|r| r.receiver_id == acc("factory.testnet")
            && r.actions.iter().any(|a| matches!(a, MockAction::FunctionCallWeight { method_name, .. } if method_name == b"on_event_created"))));
        assert!(f.get_events(None, None).is_empty(), "recorded only after callback");
    }

    #[test] fn callback_success_records_event() {
        testing_env!(ctx("alice.testnet", 0)); let mut f = Factory::new();
        with_result(PromiseResult::Successful(vec![]));
        assert!(f.on_event_created("party".into(), acc("party.factory.testnet"), acc("alice.testnet"), NearToken::from_near(3)));
        let ev = f.get_events(None, None);
        assert_eq!(ev, vec![EventRecord { name: "party".into(), account_id: acc("party.factory.testnet"),
            host: acc("alice.testnet"), created_at_ns: U64(42) }]);
        assert_eq!(f.get_event("party".into()).unwrap().host, acc("alice.testnet"));
        testing_env!(ctx("bob.testnet", 5 * D));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { create(&mut f, "party"); }));
        assert!(r.is_err(), "duplicate name must be rejected");
    }

    #[test] fn callback_failure_refunds_host() {
        testing_env!(ctx("alice.testnet", 0)); let mut f = Factory::new();
        with_result(PromiseResult::Failed);
        assert!(!f.on_event_created("x1".into(), acc("x1.factory.testnet"), acc("alice.testnet"), NearToken::from_near(3)));
        assert!(f.get_events(None, None).is_empty());
        assert!(get_created_receipts().iter().any(|r| r.receiver_id == acc("alice.testnet")
            && r.actions.iter().any(|a| matches!(a, MockAction::Transfer { deposit, .. } if *deposit == NearToken::from_near(3)))));
    }

    #[test] fn pagination() {
        testing_env!(ctx("alice.testnet", 0)); let mut f = Factory::new();
        with_result(PromiseResult::Successful(vec![]));
        for i in 0..5 { f.on_event_created(format!("e{i}"), acc(&format!("e{i}.factory.testnet")), acc("alice.testnet"), NearToken::from_near(3)); }
        assert_eq!(f.get_events(None, None).len(), 5);
        let page = f.get_events(Some(3), Some(10));
        assert_eq!(page.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["e3", "e4"]);
    }

    #[test] fn names() {
        for ok in ["ab", "party-1", "eth_denver", "a1"] { assert!(valid_name(ok), "{ok}"); }
        for bad in ["a", "Party", "a.b", "-ab", "ab-", "", "x".repeat(33).as_str(), "a b"] { assert!(!valid_name(bad), "{bad}"); }
    }

    #[test] fn min_deposit_covers_code() {
        testing_env!(ctx("alice.testnet", 0));
        assert!(min_deposit().as_yoctonear() > env::storage_byte_cost().as_yoctonear() * ESCROW_WASM.len() as u128);
    }

    #[test] #[should_panic(expected = "attach at least")] fn underfunded() {
        testing_env!(ctx("alice.testnet", D / 10)); let mut f = Factory::new(); create(&mut f, "party");
    }
    #[test] #[should_panic(expected = "invalid name")] fn bad_name() {
        testing_env!(ctx("alice.testnet", 5 * D)); let mut f = Factory::new(); create(&mut f, "Bad.Name");
    }
    #[test] #[should_panic(expected = "bad windows")] fn bad_windows() {
        testing_env!(ctx("alice.testnet", 5 * D)); let mut f = Factory::new();
        f.create_event("party".into(), NearToken::from_near(1), 5, win(300, 200, 100));
    }
}
