package poc4.sim.common;

import com.fasterxml.jackson.annotation.JsonInclude;

/** One error in an NG envelope: the error code, the message id, a message and, for validation errors, the field. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class ApiError {
    private final String code;
    private final String messageId;
    private final String message;
    private final String field;

    public ApiError(ErrorCode code, String field, String message) {
        this.code = code.name();
        this.messageId = code.getMessageId();
        this.message = message != null ? message : code.getDefaultMessage();
        this.field = field;
    }

    public String getCode() { return code; }
    public String getMessageId() { return messageId; }
    public String getMessage() { return message; }
    public String getField() { return field; }
}
