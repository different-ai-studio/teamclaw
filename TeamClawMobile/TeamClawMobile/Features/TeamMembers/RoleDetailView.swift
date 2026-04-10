import SwiftUI

struct RoleDetailView: View {
    let talent: Talent

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Header
                header

                // Role section
                if !talent.role.isEmpty {
                    sectionCard(
                        title: "角色定义",
                        icon: "person.text.rectangle",
                        color: .blue,
                        content: talent.role
                    )
                }

                // When to use
                if !talent.whenToUse.isEmpty {
                    sectionCard(
                        title: "使用场景",
                        icon: "target",
                        color: .green,
                        content: talent.whenToUse
                    )
                }

                // Working style
                if !talent.workingStyle.isEmpty {
                    sectionCard(
                        title: "工作风格",
                        icon: "gearshape.2",
                        color: .orange,
                        content: talent.workingStyle
                    )
                }

                // Skills
                if talent.downloads > 0 {
                    skillsSection
                }
            }
            .padding()
        }
        .navigationTitle(talent.name)
        .navigationBarTitleDisplayMode(.inline)
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(Color.blue.opacity(0.12))
                    .frame(width: 72, height: 72)

                Image(systemName: talent.icon)
                    .font(.title)
                    .foregroundStyle(.blue)
            }

            Text(talent.name)
                .font(.title2)
                .fontWeight(.bold)

            if !talent.talentDescription.isEmpty {
                Text(talent.talentDescription)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            HStack(spacing: 12) {
                Label(talent.category, systemImage: "tag")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(Color.orange.opacity(0.1)))

                if talent.downloads > 0 {
                    Label("\(talent.downloads) 个技能", systemImage: "puzzlepiece")
                        .font(.caption)
                        .foregroundStyle(.purple)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(Color.purple.opacity(0.1)))
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    // MARK: - Section Card

    private func sectionCard(
        title: String,
        icon: String,
        color: Color,
        content: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.subheadline)
                    .foregroundStyle(color)

                Text(title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
            }

            Text(content)
                .font(.callout)
                .foregroundStyle(.primary)
                .lineSpacing(4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }

    // MARK: - Skills Section

    private var skillsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "puzzlepiece")
                    .font(.subheadline)
                    .foregroundStyle(.purple)

                Text("关联技能")
                    .font(.subheadline)
                    .fontWeight(.semibold)
            }

            Text("该角色可使用 \(talent.downloads) 个专属技能")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }
}
