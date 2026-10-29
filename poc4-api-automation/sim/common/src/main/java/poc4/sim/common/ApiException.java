package poc4.sim.common;

/** A business error that ends the request with an NG envelope. */
public class ApiException extends RuntimeException {
    private final ErrorCode code;
    private final String field;

    public ApiException(ErrorCode code) {
        this(code, null, null);
    }

    public ApiException(ErrorCode code, String field, String message) {
        super(message != null ? message : code.getDefaultMessage());
        this.code = code;
        this.field = field;
    }

    public ErrorCode getCode() { return code; }
    public String getField() { return field; }
}
