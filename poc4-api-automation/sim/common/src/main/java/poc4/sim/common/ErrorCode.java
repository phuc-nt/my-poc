package poc4.sim.common;

import org.springframework.http.HttpStatus;

/** Error codes in the services' style (E + three digits, message id E.SIM.nnnn). The meanings are this simulation's own. */
public enum ErrorCode {
    E101(HttpStatus.UNAUTHORIZED, "Authentication is required"),
    E102(HttpStatus.FORBIDDEN, "Access is not allowed"),
    E200(HttpStatus.BAD_REQUEST, "The request is not valid"),
    E201(HttpStatus.METHOD_NOT_ALLOWED, "The method is not allowed on this path"),
    E204(HttpStatus.BAD_REQUEST, "The PIN does not match"),
    E206(HttpStatus.FORBIDDEN, "The account is locked"),
    E243(HttpStatus.NOT_FOUND, "The resource was not found"),
    E250(HttpStatus.CONFLICT, "The request conflicts with the current state"),
    E610(HttpStatus.UNPROCESSABLE_ENTITY, "The payment was declined"),
    E611(HttpStatus.BAD_GATEWAY, "A downstream service failed or did not answer in time"),
    E900(HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected error occurred");

    private final HttpStatus status;
    private final String defaultMessage;

    ErrorCode(HttpStatus status, String defaultMessage) {
        this.status = status;
        this.defaultMessage = defaultMessage;
    }

    public HttpStatus getStatus() { return status; }
    public String getDefaultMessage() { return defaultMessage; }
    public String getMessageId() { return "E.SIM.0" + name().substring(1); }
}
