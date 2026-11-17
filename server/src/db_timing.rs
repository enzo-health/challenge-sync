//! Driver-level query timing: every database operation, whichever handler issued it.
//!
//! [`TimedDriver`] wraps the driver Toasty picks from `DATABASE_URL` (Postgres in production,
//! the turso file in development) and times each `Connection::exec`, the single call every query
//! goes through. Each operation fires a `tracing` event on target `app::db` with only the
//! operation kind (`query_sql`, `insert`, ...) and its duration: never SQL, parameters or rows.
//! Debug level for every operation (`RUST_LOG=app::db=debug`), warn level above
//! [`SLOW_OP`], which the default filter shows (stdout locally, Vercel function logs deployed).
//!
//! This cannot feed the per-request `Server-Timing` header. Toasty runs `exec` on a pooled
//! connection's own background task, fed over a channel, so the request's `nextrs::Timing`
//! handle, task-locals and current tracing span are not visible here. The handlers time their
//! queries on the request side instead (`timing.span("db", ...)`), which also counts the wait for
//! a pooled connection; the gap between the two is that wait plus Toasty's own planning.

use std::borrow::Cow;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use toasty_core::driver::{Capability, Connection, Driver, ExecResponse, Operation};
use toasty_core::schema::Schema;
use toasty_core::schema::db::{AppliedMigration, Migration};
use toasty_core::schema::diff;

/// Operations slower than this are logged at warn level.
pub const SLOW_OP: Duration = Duration::from_millis(250);

#[derive(Debug)]
pub struct TimedDriver<D> {
    inner: D,
}

impl<D: Driver> TimedDriver<D> {
    pub fn new(inner: D) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl<D: Driver> Driver for TimedDriver<D> {
    fn url(&self) -> Cow<'_, str> {
        self.inner.url()
    }

    fn capability(&self) -> &'static Capability {
        self.inner.capability()
    }

    async fn connect(&self) -> toasty_core::Result<Box<dyn Connection>> {
        let start = Instant::now();
        let conn = self.inner.connect().await?;
        record("connect", start.elapsed(), true);
        Ok(Box::new(TimedConnection { inner: conn }))
    }

    fn max_connections(&self) -> Option<usize> {
        self.inner.max_connections()
    }

    fn generate_migration(&self, schema_diff: &diff::Schema<'_>) -> Migration {
        self.inner.generate_migration(schema_diff)
    }

    async fn reset_db(&self) -> toasty_core::Result<()> {
        self.inner.reset_db().await
    }
}

#[derive(Debug)]
struct TimedConnection {
    inner: Box<dyn Connection>,
}

#[async_trait]
impl Connection for TimedConnection {
    async fn exec(&mut self, schema: &Arc<Schema>, plan: Operation) -> toasty_core::Result<ExecResponse> {
        let op = op_name(&plan);
        let start = Instant::now();
        let result = self.inner.exec(schema, plan).await;
        record(op, start.elapsed(), result.is_ok());
        result
    }

    fn is_valid(&self) -> bool {
        self.inner.is_valid()
    }

    async fn ping(&mut self) -> toasty_core::Result<()> {
        self.inner.ping().await
    }

    async fn push_schema(&mut self, schema: &Schema) -> toasty_core::Result<()> {
        self.inner.push_schema(schema).await
    }

    async fn applied_migrations(&mut self) -> toasty_core::Result<Vec<AppliedMigration>> {
        self.inner.applied_migrations().await
    }

    async fn apply_migration(&mut self, id: u64, name: &str, migration: &Migration) -> toasty_core::Result<()> {
        self.inner.apply_migration(id, name, migration).await
    }
}

/// `Operation::name` borrows from the operation, which `exec` consumes; these are the same names
/// as `&'static str`.
fn op_name(plan: &Operation) -> &'static str {
    match plan {
        Operation::Insert(_) => "insert",
        Operation::DeleteByKey(_) => "delete_by_key",
        Operation::FindPkByIndex(_) => "find_pk_by_index",
        Operation::GetByKey(_) => "get_by_key",
        Operation::QueryPk(_) => "query_pk",
        Operation::QuerySql(_) => "query_sql",
        Operation::RawSql(_) => "raw_sql",
        Operation::Transaction(_) => "transaction",
        Operation::UpdateByKey(_) => "update_by_key",
        Operation::Scan(_) => "scan",
    }
}

fn record(op: &'static str, dur: Duration, ok: bool) {
    let dur_ms = dur.as_secs_f64() * 1000.0;
    if dur >= SLOW_OP {
        tracing::warn!(target: "app::db", op, dur_ms, ok, "slow database operation");
    } else {
        tracing::debug!(target: "app::db", op, dur_ms, ok, "database operation");
    }
}
