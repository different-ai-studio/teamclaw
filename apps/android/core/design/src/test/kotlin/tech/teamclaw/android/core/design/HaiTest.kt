package tech.teamclaw.android.core.design

import androidx.compose.ui.graphics.Color
import com.google.common.truth.Truth.assertThat
import org.junit.jupiter.api.Test

class HaiTest {
    @Test fun `Mist matches iOS hex F2F0EC`() {
        assertThat(Hai.Mist).isEqualTo(Color(0xFFF2F0EC))
    }

    @Test fun `Cinnabar matches iOS hex B84B36`() {
        assertThat(Hai.Cinnabar).isEqualTo(Color(0xFFB84B36))
    }

    @Test fun `Hairline is onyx at 10 percent alpha`() {
        // Compose Color packs alpha into a byte, so 0.10f → 26/255 ≈ 0.1019. Tolerance
        // accounts for the byte rounding.
        val hairline = Hai.Hairline
        assertThat(hairline.alpha).isWithin(0.01f).of(0.10f)
    }
}
