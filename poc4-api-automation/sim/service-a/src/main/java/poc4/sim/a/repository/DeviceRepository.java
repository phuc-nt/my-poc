package poc4.sim.a.repository;

import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface DeviceRepository {
    List<DeviceRecord> findByUser(@Param("userId") String userId);

    int countByUser(@Param("userId") String userId);

    void insert(DeviceRecord device);

    int delete(@Param("userId") String userId, @Param("deviceId") String deviceId);
}
