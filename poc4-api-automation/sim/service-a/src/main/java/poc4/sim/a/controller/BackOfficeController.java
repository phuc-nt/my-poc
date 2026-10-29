package poc4.sim.a.controller;

import javax.validation.Valid;
import javax.validation.constraints.Max;
import javax.validation.constraints.Min;
import javax.validation.constraints.Pattern;
import javax.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;
import poc4.sim.a.dto.ExportRequest;
import poc4.sim.a.dto.ExportStatus;
import poc4.sim.a.dto.UserPage;
import poc4.sim.a.dto.UserSummary;
import poc4.sim.a.service.ExportService;
import poc4.sim.a.service.UserService;
import poc4.sim.common.Responses;
import poc4.sim.common.RestApiResponse;
import poc4.sim.common.validation.UserId;

/** The back-office endpoints: user search and unlock, CSV export. */
@RestController
@Validated
@RequestMapping("/bo/v1")
public class BackOfficeController {
    private final UserService users;
    private final ExportService exports;

    public BackOfficeController(UserService users, ExportService exports) {
        this.users = users;
        this.exports = exports;
    }

    @GetMapping("/users")
    public ResponseEntity<RestApiResponse<UserPage>> search(
            @RequestParam(required = false) @Size(min = 3, max = 254) String email,
            @RequestParam(defaultValue = "0") @Min(0) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        return Responses.ok(users.search(email, page, size));
    }

    @PostMapping("/users/{userId}/unlock")
    public ResponseEntity<RestApiResponse<UserSummary>> unlock(@PathVariable @UserId String userId) {
        return Responses.ok(users.unlock(userId));
    }

    @PostMapping("/exports")
    public ResponseEntity<RestApiResponse<ExportStatus>> requestExport(@RequestBody @Valid ExportRequest request) {
        String baseUrl = ServletUriComponentsBuilder.fromCurrentContextPath().build().toUriString();
        return Responses.accepted(exports.request(request, baseUrl));
    }

    @GetMapping("/exports/{requestId}")
    public ResponseEntity<RestApiResponse<ExportStatus>> exportStatus(
            @PathVariable @Pattern(regexp = "^[0-9a-f-]{36}$", message = "must be a request id") String requestId) {
        return Responses.ok(exports.status(requestId));
    }
}
