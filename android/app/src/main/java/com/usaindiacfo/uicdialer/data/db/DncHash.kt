package com.usaindiacfo.uicdialer.data.db

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction

/** Do-not-call list: sha256 of each number's key (GET /v1/dnc/hashes), mirroring [ClientHashEntity]. */
@Entity(tableName = "dnc_hashes")
data class DncHashEntity(@PrimaryKey val hash: String)

@Dao
interface DncHashDao {
    @Query("SELECT EXISTS(SELECT 1 FROM dnc_hashes WHERE hash = :hash)")
    suspend fun contains(hash: String): Boolean

    @Query("DELETE FROM dnc_hashes")
    suspend fun clear()

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(rows: List<DncHashEntity>)

    /** Swaps the list in one transaction; [LOADED] marks "downloaded once" and is wiped with the table. */
    @Transaction
    suspend fun replaceAll(hashes: List<String>) {
        clear()
        insertAll(listOf(DncHashEntity(LOADED)))
        hashes.chunked(500).forEach { chunk -> insertAll(chunk.map(::DncHashEntity)) }
    }

    /** False after sign-out cleared the table: the ETag must not be sent then (a 304 would leave it empty). */
    suspend fun loaded(): Boolean = contains(LOADED)

    companion object {
        const val LOADED = "loaded"
    }
}
