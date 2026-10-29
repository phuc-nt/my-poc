package poc4.sim.a.controller;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import poc4.sim.a.service.ExportService;
import poc4.sim.common.ApiException;
import poc4.sim.common.ErrorCode;

/** Serves finished exports behind a signed, expiring link, the way a presigned bucket URL does. */
@RestController
public class FileController {
    private final ExportService exports;

    public FileController(ExportService exports) {
        this.exports = exports;
    }

    @GetMapping(value = "/files/{fileName}", produces = "text/csv")
    public ResponseEntity<byte[]> download(@PathVariable String fileName, @RequestParam long expires,
                                           @RequestParam String signature) {
        byte[] content = exports.download(fileName, expires, signature);
        if (content == null) {
            throw new ApiException(ErrorCode.E102, null, "The link is not valid or has expired");
        }
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("text/csv; charset=UTF-8")).body(content);
    }
}
