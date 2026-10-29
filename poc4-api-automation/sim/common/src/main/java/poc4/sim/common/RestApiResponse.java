package poc4.sim.common;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.swagger.v3.oas.annotations.media.Schema;
import java.util.List;

/** The envelope every endpoint answers with: result OK and the data on success, result NG and the errors on failure. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class RestApiResponse<T> {
    public static final String OK = "OK";
    public static final String NG = "NG";

    @Schema(allowableValues = {OK, NG})
    private final String result;
    private final T data;
    private final List<ApiError> errors;

    private RestApiResponse(String result, T data, List<ApiError> errors) {
        this.result = result;
        this.data = data;
        this.errors = errors;
    }

    public static <T> RestApiResponse<T> ok(T data) {
        return new RestApiResponse<>(OK, data, null);
    }

    public static RestApiResponse<Void> ng(List<ApiError> errors) {
        return new RestApiResponse<>(NG, null, errors);
    }

    public String getResult() { return result; }
    public T getData() { return data; }
    public List<ApiError> getErrors() { return errors; }
}
