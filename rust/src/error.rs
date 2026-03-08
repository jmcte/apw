use crate::types::Status;
use std::fmt;

#[derive(Debug, Clone)]
pub struct APWError {
    pub code: Status,
    pub message: String,
}

impl APWError {
    pub fn new<T: Into<String>>(code: Status, message: T) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for APWError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for APWError {}

pub type Result<T> = std::result::Result<T, APWError>;
