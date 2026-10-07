#![allow(dead_code)]

//! Native directory import core and FI-I command surface.
//!
//! FI-I declares this module at the crate root, registers the seven commands,
//! and manages `DirectoryImportState`.  The activity gate is shared with the
//! legacy linked/managed import path so the two entry points cannot race on the
//! portable repository.

pub(crate) mod activity;
pub(crate) mod commands;
pub(crate) mod job;
pub(crate) mod planner;
pub(crate) mod policy;
mod runner;
pub(crate) mod scanner;
pub(crate) mod types;
