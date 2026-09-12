use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TaskState {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl TaskState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "queued" => Self::Queued,
            "running" => Self::Running,
            "paused" => Self::Paused,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TaskTransition {
    Start,
    Pause,
    Resume,
    Complete,
    Fail(String),
    Cancel,
}

pub(crate) fn next_state(
    current: TaskState,
    transition: &TaskTransition,
) -> Result<TaskState, String> {
    let next = match (current, transition) {
        (TaskState::Queued, TaskTransition::Start) => TaskState::Running,
        (TaskState::Queued, TaskTransition::Cancel) => TaskState::Cancelled,
        (TaskState::Running, TaskTransition::Pause) => TaskState::Paused,
        (TaskState::Running, TaskTransition::Complete) => TaskState::Completed,
        (TaskState::Running, TaskTransition::Fail(_)) => TaskState::Failed,
        (TaskState::Running, TaskTransition::Cancel) => TaskState::Cancelled,
        (TaskState::Paused, TaskTransition::Resume) => TaskState::Running,
        (TaskState::Paused, TaskTransition::Cancel) => TaskState::Cancelled,
        _ => {
            return Err(format!(
                "不允许将 {} 通过 {:?} 转换",
                current.as_str(),
                transition
            ))
        }
    };
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_machine_allows_only_lifecycle_transitions() {
        assert_eq!(
            next_state(TaskState::Queued, &TaskTransition::Start).unwrap(),
            TaskState::Running
        );
        assert_eq!(
            next_state(TaskState::Running, &TaskTransition::Pause).unwrap(),
            TaskState::Paused
        );
        assert_eq!(
            next_state(TaskState::Paused, &TaskTransition::Resume).unwrap(),
            TaskState::Running
        );
        assert_eq!(
            next_state(TaskState::Running, &TaskTransition::Complete).unwrap(),
            TaskState::Completed
        );
        assert!(next_state(TaskState::Completed, &TaskTransition::Cancel).is_err());
    }
}
