package poc4.sim.common;

import com.fasterxml.jackson.databind.exc.MismatchedInputException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;
import javax.validation.ConstraintViolation;
import javax.validation.ConstraintViolationException;
import javax.validation.Path;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;

/** Turns every failure into an NG envelope with the matching HTTP status and error code. */
@RestControllerAdvice
public class GlobalExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<RestApiResponse<Void>> api(ApiException e) {
        return answer(e.getCode(), List.of(new ApiError(e.getCode(), e.getField(), e.getMessage())));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<RestApiResponse<Void>> body(MethodArgumentNotValidException e) {
        List<ApiError> errors = new ArrayList<>();
        e.getBindingResult().getFieldErrors()
                .forEach(f -> errors.add(new ApiError(ErrorCode.E200, f.getField(), f.getDefaultMessage())));
        e.getBindingResult().getGlobalErrors()
                .forEach(g -> errors.add(new ApiError(ErrorCode.E200, null, g.getDefaultMessage())));
        return answer(ErrorCode.E200, errors);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<RestApiResponse<Void>> parameter(ConstraintViolationException e) {
        List<ApiError> errors = e.getConstraintViolations().stream()
                .map(v -> new ApiError(ErrorCode.E200, lastNode(v), v.getMessage()))
                .collect(Collectors.toList());
        return answer(ErrorCode.E200, errors);
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<RestApiResponse<Void>> unreadable(HttpMessageNotReadableException e) {
        String field = null;
        if (e.getCause() instanceof MismatchedInputException) {
            field = ((MismatchedInputException) e.getCause()).getPath().stream()
                    .map(r -> r.getFieldName() != null ? r.getFieldName() : String.valueOf(r.getIndex()))
                    .collect(Collectors.joining("."));
        }
        return answer(ErrorCode.E200, List.of(new ApiError(ErrorCode.E200, field, "The request body is not readable")));
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public ResponseEntity<RestApiResponse<Void>> missingParameter(MissingServletRequestParameterException e) {
        return answer(ErrorCode.E200, List.of(new ApiError(ErrorCode.E200, e.getParameterName(), "is required")));
    }

    @ExceptionHandler(MissingRequestHeaderException.class)
    public ResponseEntity<RestApiResponse<Void>> missingHeader(MissingRequestHeaderException e) {
        return answer(ErrorCode.E200, List.of(new ApiError(ErrorCode.E200, e.getHeaderName(), "is required")));
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<RestApiResponse<Void>> mismatch(MethodArgumentTypeMismatchException e) {
        return answer(ErrorCode.E200, List.of(new ApiError(ErrorCode.E200, e.getName(), "has a value of the wrong type")));
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<RestApiResponse<Void>> mediaType(HttpMediaTypeNotSupportedException e) {
        return answer(ErrorCode.E200, List.of(new ApiError(ErrorCode.E200, null, "The content type is not supported")));
    }

    @ExceptionHandler(NoHandlerFoundException.class)
    public ResponseEntity<RestApiResponse<Void>> noHandler(NoHandlerFoundException e) {
        return answer(ErrorCode.E243, List.of(new ApiError(ErrorCode.E243, null, "No endpoint at this path")));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<RestApiResponse<Void>> method(HttpRequestMethodNotSupportedException e) {
        return answer(ErrorCode.E201, List.of(new ApiError(ErrorCode.E201, null, null)));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<RestApiResponse<Void>> unexpected(Exception e) {
        log.error("unexpected error", e);
        return answer(ErrorCode.E900, List.of(new ApiError(ErrorCode.E900, null, null)));
    }

    private static ResponseEntity<RestApiResponse<Void>> answer(ErrorCode code, List<ApiError> errors) {
        List<ApiError> sorted = new ArrayList<>(errors);
        sorted.sort(Comparator.comparing(a -> a.getField() == null ? "" : a.getField()));
        return ResponseEntity.status(code.getStatus()).body(RestApiResponse.ng(sorted));
    }

    private static String lastNode(ConstraintViolation<?> v) {
        String name = null;
        for (Path.Node node : v.getPropertyPath()) {
            name = node.getName();
        }
        return name;
    }
}
