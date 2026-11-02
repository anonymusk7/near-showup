//! ShowUp event escrow: deposit to RSVP, refund on timely cancel,
//! attendees split the no-show pool on settle.
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Status { Rsvp, Cancelled, CheckedIn }

#[near(serializers = [json])]
pub struct Payout { pub account_id: AccountId, pub amount: NearToken }

/// Pure settle math, shared by contract and tests (mirrored in scripts/settle.mjs).
/// Returns (per_attendee_amount, dust_to_host).
pub fn settle_math(deposit: u128, attendees: u128, no_shows: u128) -> (u128, u128) {
    let pool = deposit * no_shows;
    if attendees == 0 { return (0, pool); }
    let share = pool / attendees;
    (deposit + share, pool - share * attendees)
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Event {
    host: AccountId,
    checkers: Vec<AccountId>,
    deposit: NearToken,
    capacity: u32,
    cancel_deadline_ns: u64,
    checkin_start_ns: u64,
    checkin_end_ns: u64,
    guests: IterableMap<AccountId, Status>,
    active: u32,
    settled: bool,
}

#[near]
impl Event {
    #[init]
    pub fn new(host: AccountId, deposit: NearToken, capacity: u32,
               cancel_deadline_ns: u64, checkin_start_ns: u64, checkin_end_ns: u64) -> Self {
        require!(capacity > 0, "capacity must be > 0");
        require!(deposit.as_yoctonear() > 0, "deposit must be > 0");
        require!(cancel_deadline_ns <= checkin_start_ns && checkin_start_ns < checkin_end_ns, "bad windows");
        Self { host, checkers: vec![], deposit, capacity, cancel_deadline_ns,
               checkin_start_ns, checkin_end_ns, guests: IterableMap::new(b"g"), active: 0, settled: false }
    }

    #[payable]
    pub fn rsvp(&mut self) {
        let who = env::predecessor_account_id();
        let att = env::attached_deposit();
        require!(att == self.deposit, "attach exactly the deposit");
        require!(env::block_timestamp() < self.cancel_deadline_ns, "RSVP closed");
        require!(self.active < self.capacity, "event full");
        if let Some(s) = self.guests.get(&who) { require!(*s == Status::Cancelled, "already RSVPed"); }
        self.guests.insert(who, Status::Rsvp);
        self.active += 1;
    }

    pub fn cancel(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        require!(env::block_timestamp() < self.cancel_deadline_ns, "cancellation deadline passed");
        require!(self.guests.get(&who) == Some(&Status::Rsvp), "no active RSVP");
        self.guests.insert(who.clone(), Status::Cancelled);
        self.active -= 1;
        Promise::new(who).transfer(self.deposit)
    }

    pub fn add_checker(&mut self, account_id: AccountId) {
        self.only_host();
        if !self.checkers.contains(&account_id) { self.checkers.push(account_id); }
    }

    pub fn check_in(&mut self, guest: AccountId) {
        let who = env::predecessor_account_id();
        require!(who == self.host || self.checkers.contains(&who), "not authorized to check in");
        let now = env::block_timestamp();
        require!(now >= self.checkin_start_ns && now <= self.checkin_end_ns, "outside check-in window");
        require!(self.guests.get(&guest) == Some(&Status::Rsvp), "guest has no active RSVP");
        self.guests.insert(guest, Status::CheckedIn);
    }

    /// Anyone can settle once the check-in window is over.
    pub fn settle(&mut self) -> Vec<Payout> {
        require!(!self.settled, "already settled");
        require!(env::block_timestamp() > self.checkin_end_ns, "event not over");
        self.settled = true;
        let attendees: Vec<AccountId> = self.guests.iter()
            .filter(|(_, s)| **s == Status::CheckedIn).map(|(a, _)| a.clone()).collect();
        let no_shows = self.guests.values().filter(|s| **s == Status::Rsvp).count() as u128;
        let (each, dust) = settle_math(self.deposit.as_yoctonear(), attendees.len() as u128, no_shows);
        let mut out = vec![];
        for a in attendees {
            Promise::new(a.clone()).transfer(NearToken::from_yoctonear(each));
            out.push(Payout { account_id: a, amount: NearToken::from_yoctonear(each) });
        }
        if dust > 0 {
            Promise::new(self.host.clone()).transfer(NearToken::from_yoctonear(dust));
            out.push(Payout { account_id: self.host.clone(), amount: NearToken::from_yoctonear(dust) });
        }
        out
    }

    pub fn get_status(&self, account_id: AccountId) -> Option<Status> { self.guests.get(&account_id).copied() }
    pub fn get_guests(&self) -> Vec<(AccountId, Status)> { self.guests.iter().map(|(a, s)| (a.clone(), *s)).collect() }
    pub fn get_info(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({"host": self.host, "deposit": self.deposit, "capacity": self.capacity,
          "active": self.active, "cancel_deadline_ns": self.cancel_deadline_ns.to_string(),
          "checkin_start_ns": self.checkin_start_ns.to_string(), "checkin_end_ns": self.checkin_end_ns.to_string(),
          "settled": self.settled, "checkers": self.checkers})
    }

    fn only_host(&self) { require!(env::predecessor_account_id() == self.host, "host only"); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const D: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR
    fn acc(s: &str) -> AccountId { format!("{s}.testnet").parse().unwrap() }
    fn ctx(who: &str, t: u64, dep: u128) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(who))
            .block_timestamp(t).attached_deposit(NearToken::from_yoctonear(dep)).build());
    }
    fn ev() -> Event { ctx("host", 0, 0); Event::new(acc("host"), NearToken::from_yoctonear(D), 10, 100, 200, 300) }

    #[test] fn full_flow() {
        let mut e = ev();
        for g in ["a","b","c","d","e"] { ctx(g, 10, D); e.rsvp(); }
        ctx("e", 50, 0); e.cancel();
        ctx("host", 0, 0); e.add_checker(acc("door"));
        for g in ["a","b","c"] { ctx("door", 250, 0); e.check_in(acc(g)); }
        ctx("anyone", 301, 0);
        let p = e.settle();
        assert_eq!(p.len(), 3 + 1); // 3 attendees + 1 yocto dust to host (1 no-show: D/3)
        let each = p[0].amount.as_yoctonear();
        assert_eq!(each, D + D / 3);
        let total: u128 = p.iter().map(|x| x.amount.as_yoctonear()).sum();
        assert_eq!(total, 4 * D); // 4 active deposits fully conserved
    }
    #[test] #[should_panic(expected = "attach exactly")] fn wrong_deposit() { let mut e = ev(); ctx("a", 1, D-1); e.rsvp(); }
    #[test] #[should_panic(expected = "deadline passed")] fn late_cancel() { let mut e = ev(); ctx("a",1,D); e.rsvp(); ctx("a",150,0); e.cancel(); }
    #[test] #[should_panic(expected = "not authorized")] fn stranger_checkin() { let mut e = ev(); ctx("a",1,D); e.rsvp(); ctx("a",250,0); e.check_in(acc("a")); }
    #[test] #[should_panic(expected = "outside check-in")] fn early_checkin() { let mut e = ev(); ctx("a",1,D); e.rsvp(); ctx("host",150,0); e.check_in(acc("a")); }
    #[test] #[should_panic(expected = "event not over")] fn early_settle() { let mut e = ev(); ctx("x",250,0); e.settle(); }
    #[test] #[should_panic(expected = "already settled")] fn double_settle() { let mut e = ev(); ctx("x",301,0); e.settle(); e.settle(); }
    #[test] #[should_panic(expected = "event full")] fn capacity() {
        ctx("host",0,0); let mut e = Event::new(acc("host"), NearToken::from_yoctonear(D), 1, 100, 200, 300);
        ctx("a",1,D); e.rsvp(); ctx("b",1,D); e.rsvp(); }
    #[test] fn re_rsvp_after_cancel() { let mut e = ev(); ctx("a",1,D); e.rsvp(); e.cancel(); ctx("a",2,D); e.rsvp(); assert_eq!(e.get_status(acc("a")), Some(Status::Rsvp)); }
    #[test] fn no_attendees_pool_to_host() { assert_eq!(settle_math(D, 0, 3), (0, 3*D)); }
    #[test] fn settle_conservation_property() {
        // deterministic pseudo-random sweep: sum of payouts == deposit * (attendees + no_shows)
        let mut x: u64 = 0x9E3779B97F4A7C15;
        for _ in 0..10_000 {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            let dep = (x % 1_000_000_007) as u128 * 1_000_000_000 + 1;
            let a = ((x >> 20) % 200) as u128; let n = ((x >> 40) % 200) as u128;
            let (each, dust) = settle_math(dep, a, n);
            assert_eq!(each * a + dust, dep * (a + n));
            assert!(dust < a.max(1) || a == 0);
            if a > 0 { assert!(each >= dep); }
        }
    }
}
